$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location $projectRoot

$nodeVersion = '24.20.0'
$toolsDir = Join-Path $projectRoot '.tools'
$downloadDir = $null

function Test-CompatibleNode {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not $npmCommand) { return $false }

    try {
        $major = & node -p 'Number(process.versions.node.split(".")[0])' 2>$null
        return ([int]$major -ge 22)
    } catch {
        return $false
    }
}

try {
    if (Test-CompatibleNode) {
        $npmCommand = (Get-Command npm.cmd).Source
    } else {
        $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        switch ($architecture) {
            'x64' {
                $nodeArch = 'x64'
                $expectedSha256 = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'
            }
            'arm64' {
                $nodeArch = 'arm64'
                $expectedSha256 = '31c6799744de8a54601643098040c68c3697e56c94e407d61d0e5fa5f34191d7'
            }
            default {
                throw "Unsupported Windows architecture: $architecture. Ask IT to install Node.js 24 LTS."
            }
        }

        $archiveName = "node-v$nodeVersion-win-$nodeArch.zip"
        $nodeHome = Join-Path $toolsDir "node-v$nodeVersion-win-$nodeArch"
        $nodeExe = Join-Path $nodeHome 'node.exe'

        if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
            New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
            $downloadDir = Join-Path $toolsDir ("node-download-" + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $downloadDir | Out-Null
            $archivePath = Join-Path $downloadDir $archiveName
            $nodeUrl = "https://nodejs.org/dist/v$nodeVersion/$archiveName"

            Write-Host "Node.js is missing or too old. Downloading the project-local Node.js $nodeVersion runtime..."
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri $nodeUrl -OutFile $archivePath

            $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualSha256 -ne $expectedSha256) {
                throw 'The Node.js download checksum did not match. The file will not be used.'
            }

            Write-Host 'Download verified. Installing Node.js inside this project (no administrator password needed)...'
            Expand-Archive -LiteralPath $archivePath -DestinationPath $downloadDir
            if (Test-Path -LiteralPath $nodeHome) {
                Remove-Item -LiteralPath $nodeHome -Recurse -Force
            }
            Move-Item -LiteralPath (Join-Path $downloadDir "node-v$nodeVersion-win-$nodeArch") -Destination $nodeHome
        }

        $env:Path = "$nodeHome;$env:Path"
        $npmCommand = Join-Path $nodeHome 'npm.cmd'
    }

    Write-Host "Using Node.js $(& node --version) and npm $(& $npmCommand --version)."
    Write-Host 'Installing the project packages and its private Chromium browser. This can take several minutes...'
    & $npmCommand run setup
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Write-Error "Setup stopped: $($_.Exception.Message)"
    exit 1
} finally {
    if ($downloadDir -and (Test-Path -LiteralPath $downloadDir)) {
        Remove-Item -LiteralPath $downloadDir -Recurse -Force
    }
}
