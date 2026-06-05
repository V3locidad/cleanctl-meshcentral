/*
 * cleanctl — agent-side cleaner.
 *
 * Reçoit { pluginaction:'clean', dispatchId, tasks:['temp','browser','dism','profiles'], profileDays:90 }
 * Exécute chaque tâche via PowerShell, calcule les Mo libérés, et renvoie un
 * cleanComplete avec un détail par tâche.
 *
 * Note Duktape: child.exitCode n'est jamais mis à jour, donc on attache un
 * handler 'exit' et un timeout par tâche.
 */

"use strict";

var mesh = null;

function dbg(m) {
    try {
        var fs = require('fs');
        var s = fs.createWriteStream('cleanctl.txt', { flags: 'a' });
        s.write('\n' + new Date().toLocaleString() + ': ' + m);
        s.end('\n');
    } catch (e) {}
}

function reply(payload) {
    var msg = { action: 'plugin', plugin: 'cleanctl' };
    Object.keys(payload).forEach(function (k) { msg[k] = payload[k]; });
    try {
        if (mesh && typeof mesh.SendCommand === 'function') mesh.SendCommand(msg);
        else require('MeshAgent').SendCommand(JSON.stringify(msg));
    } catch (e) { dbg('reply error: ' + e); }
}

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    var fnname = args.pluginaction || (args._ && args._[1]);
    try {
        switch (fnname) {
            case 'ping':
                reply({ pluginaction: 'pong', dispatchId: args.dispatchId, agent: process.platform });
                return 'pong';
            case 'clean':
                doClean(args);
                return 'clean started';
            default:
                return 'cleanctl: action inconnue ' + fnname;
        }
    } catch (e) {
        dbg('consoleaction error: ' + e);
        reply({ pluginaction: 'cleanComplete', dispatchId: args && args.dispatchId, ok: false, error: String(e) });
        return 'error ' + e;
    }
}

module.exports = { consoleaction: consoleaction };

// --- PowerShell scripts par tâche ---
// Chaque script écrit sur stdout une dernière ligne "RESULT:<bytesFreed>:<note>"
// pour qu'on puisse parser le résultat. Le reste va dans log.

var PS_TEMP = ''
    + '$ErrorActionPreference = "SilentlyContinue";'
    + '$paths = @("$env:TEMP","C:\\Windows\\Temp","C:\\Windows\\Prefetch","C:\\Windows\\SoftwareDistribution\\Download");'
    + '$total = 0;'
    + 'foreach ($p in $paths) {'
    + '  if (Test-Path $p) {'
    + '    $sz = (Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum;'
    + '    if ($sz) { $total += $sz }'
    + '    Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | ForEach-Object {'
    + '      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue'
    + '    };'
    + '    Write-Host ("cleaned: " + $p)'
    + '  } else { Write-Host ("skip (missing): " + $p) }'
    + '}'
    + 'Write-Host ("RESULT:" + $total + ":ok")';

var PS_BROWSER = ''
    + '$ErrorActionPreference = "SilentlyContinue";'
    + '$users = Get-ChildItem "C:\\Users" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @("Default","Default User","Public","All Users") };'
    + '$rel = @('
    + '  "AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache",'
    + '  "AppData\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache",'
    + '  "AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache",'
    + '  "AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Code Cache",'
    + '  "AppData\\Local\\Mozilla\\Firefox\\Profiles"'
    + ');'
    + '$total = 0;'
    + 'foreach ($u in $users) {'
    + '  foreach ($r in $rel) {'
    + '    $p = Join-Path $u.FullName $r;'
    + '    if (Test-Path $p) {'
    + '      if ($r -like "*Firefox*") {'
    + '        Get-ChildItem $p -Directory -ErrorAction SilentlyContinue | ForEach-Object {'
    + '          $c1 = Join-Path $_.FullName "cache2";'
    + '          $c2 = Join-Path $_.FullName "startupCache";'
    + '          foreach ($c in @($c1,$c2)) {'
    + '            if (Test-Path $c) {'
    + '              $sz = (Get-ChildItem $c -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum;'
    + '              if ($sz) { $total += $sz }'
    + '              Remove-Item $c -Recurse -Force -ErrorAction SilentlyContinue'
    + '            }'
    + '          }'
    + '        }'
    + '      } else {'
    + '        $sz = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum;'
    + '        if ($sz) { $total += $sz }'
    + '        Get-ChildItem $p -Force -ErrorAction SilentlyContinue | ForEach-Object {'
    + '          Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue'
    + '        }'
    + '      }'
    + '      Write-Host ("cleaned: " + $p)'
    + '    }'
    + '  }'
    + '}'
    + 'Write-Host ("RESULT:" + $total + ":ok")';

var PS_DISM = ''
    + '$ErrorActionPreference = "SilentlyContinue";'
    + '$before = (Get-PSDrive C).Free;'
    + 'Write-Host "DISM /Online /Cleanup-Image /StartComponentCleanup ...";'
    + 'Start-Process -FilePath "Dism.exe" -ArgumentList "/Online","/Cleanup-Image","/StartComponentCleanup","/Quiet" -Wait -NoNewWindow;'
    + 'if (Test-Path "C:\\Windows.old") {'
    + '  Write-Host "Removing C:\\Windows.old";'
    + '  takeown /F "C:\\Windows.old" /R /D Y | Out-Null;'
    + '  icacls "C:\\Windows.old" /grant administrators:F /T /C | Out-Null;'
    + '  Remove-Item "C:\\Windows.old" -Recurse -Force -ErrorAction SilentlyContinue'
    + '}'
    + 'Write-Host "vssadmin delete shadows /for=C: /oldest";'
    + 'cmd /c "vssadmin delete shadows /for=C: /oldest /quiet" 2>&1 | Out-Null;'
    + '$after = (Get-PSDrive C).Free;'
    + '$freed = $after - $before;'
    + 'if ($freed -lt 0) { $freed = 0 }'
    + 'Write-Host ("RESULT:" + $freed + ":ok")';

// Liste des comptes à PRÉSERVER, passée à DelProf2 via /ed:<name> (multi-OK).
// Le pattern accepte * comme wildcard. Doublons avec accents FR couverts ici.
var PROFILE_SKIP = [
    'Administrator', 'Administrateur', 'admin',
    'Default*', 'Public', 'All Users',
    'DefaultAppPool', 'IUSR', 'IWAM',
    'systemprofile', 'LocalService', 'NetworkService',
    'defaultuser0', 'WDAGUtilityAccount',
    'maintenance'
];

function buildDelprof2Args(days) {
    var args = ['/u', '/i', '/d:' + (parseInt(days, 10) || 90)];
    for (var i = 0; i < PROFILE_SKIP.length; i++) {
        args.push('/ed:' + PROFILE_SKIP[i]);
    }
    return args;
}

function downloadFile(url, dest, cb) {
    var fs = require('fs');
    var http = (url.indexOf('https:') === 0) ? require('https') : require('http');
    var done = false;
    function finish(err) {
        if (done) return;
        done = true;
        cb(err || null);
    }
    try {
        var f = fs.createWriteStream(dest);
        var req = http.get(url, { rejectUnauthorized: false }, function (res) {
            if (res.statusCode !== 200) {
                try { f.close(); } catch (_) {}
                try { fs.unlinkSync(dest); } catch (_) {}
                return finish(new Error('HTTP ' + res.statusCode));
            }
            res.pipe(f);
            f.on('close', function () { finish(null); });
            f.on('error', function (e) { finish(e); });
        });
        req.on('error', function (e) {
            try { f.close(); } catch (_) {}
            try { fs.unlinkSync(dest); } catch (_) {}
            finish(e);
        });
        // Pas de req.setTimeout sur Duktape — on garde un fallback global.
        setTimeout(function () {
            if (done) return;
            try { if (req && typeof req.abort === 'function') req.abort(); } catch (_) {}
            try { if (req && typeof req.destroy === 'function') req.destroy(); } catch (_) {}
            try { f.close(); } catch (_) {}
            try { fs.unlinkSync(dest); } catch (_) {}
            finish(new Error('download timeout'));
        }, 60000);
    } catch (e) { finish(e); }
}

// Exécute DelProf2.exe. Renvoie { ok, bytes, removed, log } via onDone.
function runDelprof2(exePath, days, timeoutMs, onDone) {
    var fs = require('fs');
    var cp = require('child_process');
    var log = '';
    var done = false;
    // Capacité disque avant (via PowerShell — DelProf2 ne renvoie pas la taille).
    var psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    cp.execFile(psExe, ['-NoProfile', '-Command', '(Get-PSDrive C).Free'], function (err, stdout) {
        var before = parseInt((stdout || '').trim(), 10) || 0;
        var child;
        try {
            child = cp.execFile(exePath, buildDelprof2Args(days));
        } catch (e) { return onDone(false, 0, 0, 'spawn DelProf2 failed: ' + e); }

        if (child.stdout) child.stdout.on('data', function (d) { log += d.toString(); });
        if (child.stderr) child.stderr.on('data', function (d) { log += d.toString(); });

        function finish(ok, errMsg) {
            if (done) return;
            done = true;
            cp.execFile(psExe, ['-NoProfile', '-Command', '(Get-PSDrive C).Free'], function (err2, stdout2) {
                var after = parseInt((stdout2 || '').trim(), 10) || 0;
                var freed = after - before;
                if (freed < 0) freed = 0;
                // DelProf2 trace "Deleted profile: ..." par compte supprimé.
                var removed = (log.match(/Deleted profile:/gi) || []).length;
                onDone(ok, freed, removed, log + (errMsg ? '\n' + errMsg : ''));
            });
        }
        child.on('exit', function () { finish(true, ''); });
        setTimeout(function () {
            if (done) return;
            try { child.kill(); } catch (_) {}
            finish(false, 'DelProf2 timeout');
        }, timeoutMs);
    });
}

function runPowerShell(script, timeoutMs, onDone) {
    var fs = require('fs');
    var cp = require('child_process');
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var ps1 = tmpRoot + '\\cleanctl_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.ps1';
    var log = '';
    var done = false;
    var bytes = 0;
    var note = '';

    try { fs.writeFileSync(ps1, script); }
    catch (e) { onDone(false, 0, '', 'write ps1 failed: ' + e); return; }

    var psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var child;
    try {
        child = cp.execFile(psExe, [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive',
            '-File', ps1
        ]);
    } catch (e) { onDone(false, 0, '', 'spawn failed: ' + e); return; }

    if (child.stdout) {
        child.stdout.on('data', function (d) {
            var s = d.toString();
            log += s;
            var lines = s.split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var m = lines[i].match(/^RESULT:(\d+):(.*)$/);
                if (m) { bytes = parseInt(m[1], 10) || 0; note = m[2] || ''; }
            }
        });
    }
    if (child.stderr) {
        child.stderr.on('data', function (d) { log += d.toString(); });
    }

    function finish(ok, err) {
        if (done) return;
        done = true;
        try { fs.unlinkSync(ps1); } catch (_) {}
        onDone(ok, bytes, log, note || (err || ''));
    }

    child.on('exit', function () { finish(true, ''); });

    setTimeout(function () {
        if (done) return;
        try { child.kill(); } catch (_) {}
        finish(false, 'timeout');
    }, timeoutMs);
}

function doProfilesTask(data, profileDays, cb) {
    var fs = require('fs');
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var exePath = tmpRoot + '\\cleanctl_DelProf2.exe';
    var url = data.delprof2Url || '';
    if (!url) return cb(false, 0, 0, 'delprof2Url manquant — serveur n\'a pas envoyé l\'URL (baseUrl pas encore captée ?)');

    function runIt() {
        runDelprof2(exePath, profileDays, 30 * 60 * 1000, function (ok, freed, removed, log) {
            cb(ok, freed, removed, log);
        });
    }

    // Re-télécharge à chaque run pour invalider une version vieille/corrompue,
    // et parce que le token est single-shot côté serveur.
    try { if (fs.existsSync(exePath)) fs.unlinkSync(exePath); } catch (_) {}
    downloadFile(url, exePath, function (err) {
        if (err) return cb(false, 0, 0, 'download DelProf2 échoué: ' + err.message);
        if (!fs.existsSync(exePath)) return cb(false, 0, 0, 'DelProf2 introuvable après download');
        runIt();
    });
}

function doClean(data) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'cleanComplete', dispatchId: data.dispatchId, ok: false, error: 'cleanctl: Windows only' });
        return;
    }
    var tasks = (data.tasks && data.tasks.length) ? data.tasks : ['temp'];
    var profileDays = data.profileDays || 90;
    var results = {};
    var idx = 0;

    function next() {
        if (idx >= tasks.length) {
            reply({
                pluginaction: 'cleanComplete',
                dispatchId: data.dispatchId,
                ok: true,
                results: results
            });
            return;
        }
        var t = tasks[idx++];
        if (t === 'profiles') {
            return doProfilesTask(data, profileDays, function (ok, bytes, removed, log) {
                var note = (removed != null) ? String(removed) : '';
                results[t] = { ok: ok, bytes: bytes, note: note, logTail: (log || '').slice(-1500) };
                reply({
                    pluginaction: 'cleanProgress', dispatchId: data.dispatchId,
                    task: t, ok: ok, bytes: bytes, note: note
                });
                next();
            });
        }
        var script = '', timeout = 5 * 60 * 1000;
        switch (t) {
            case 'temp':     script = PS_TEMP; break;
            case 'browser':  script = PS_BROWSER; timeout = 10 * 60 * 1000; break;
            case 'dism':     script = PS_DISM; timeout = 30 * 60 * 1000; break;
            default:
                results[t] = { ok: false, bytes: 0, note: 'unknown task' };
                next(); return;
        }
        runPowerShell(script, timeout, function (ok, bytes, log, note) {
            results[t] = { ok: ok, bytes: bytes, note: note, logTail: (log || '').slice(-1500) };
            reply({
                pluginaction: 'cleanProgress',
                dispatchId: data.dispatchId,
                task: t,
                ok: ok,
                bytes: bytes,
                note: note
            });
            next();
        });
    }
    next();
}
