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

function PS_PROFILES(days) {
    return ''
    + '$ErrorActionPreference = "SilentlyContinue";'
    + '$days = ' + (parseInt(days, 10) || 90) + ';'
    + '$cutoff = (Get-Date).AddDays(-$days);'
    + '$skip = @("Administrator","Administrateur","admin","Default","Default User","DefaultAppPool","Public","All Users","systemprofile","LocalService","NetworkService","defaultuser0","maintenance","WDAGUtilityAccount","IUSR","IWAM");'
    + '$before = (Get-PSDrive C).Free;'
    + '$removed = 0;'
    + 'Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object {'
    + '  -not $_.Special -and -not $_.Loaded -and $_.LocalPath -and '
    + '  ($_.SID -notlike "S-1-5-18*") -and ($_.SID -notlike "S-1-5-19*") -and ($_.SID -notlike "S-1-5-20*") -and ($_.SID -notlike "S-1-5-80*") -and ($_.SID -notlike "S-1-5-82*") -and '
    + '  ($skip -notcontains (Split-Path $_.LocalPath -Leaf))'
    + '} | ForEach-Object {'
    + '  $p = $_;'
    + '  $lu = $null;'
    + '  try { $lu = $p.LastUseTime } catch {}'
    + '  if (-not $lu) {'
    + '    try { $lu = (Get-Item $p.LocalPath -ErrorAction SilentlyContinue).LastWriteTime } catch {}'
    + '  }'
    + '  if ($lu -and $lu -lt $cutoff) {'
    + '    Write-Host ("removing: " + $p.LocalPath + " (last: " + $lu + ")");'
    + '    try { Remove-CimInstance -InputObject $p -ErrorAction Stop; $removed++ }'
    + '    catch { Write-Host ("fail: " + $_.Exception.Message) }'
    + '  }'
    + '}'
    + 'Write-Host ("profiles removed: " + $removed);'
    + '$after = (Get-PSDrive C).Free;'
    + '$freed = $after - $before;'
    + 'if ($freed -lt 0) { $freed = 0 }'
    + 'Write-Host ("RESULT:" + $freed + ":" + $removed)';
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
        var script = '', timeout = 5 * 60 * 1000;
        switch (t) {
            case 'temp':     script = PS_TEMP; break;
            case 'browser':  script = PS_BROWSER; timeout = 10 * 60 * 1000; break;
            case 'dism':     script = PS_DISM; timeout = 30 * 60 * 1000; break;
            case 'profiles': script = PS_PROFILES(profileDays); timeout = 30 * 60 * 1000; break;
            default:
                results[t] = { ok: false, bytes: 0, note: 'unknown task' };
                next(); return;
        }
        runPowerShell(script, timeout, function (ok, bytes, log, note) {
            results[t] = { ok: ok, bytes: bytes, note: note, logTail: (log || '').slice(-1500) };
            // Progress event so the UI can show per-task ticks.
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
