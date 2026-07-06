# NSSM 2.24 (Non-Sucking Service Manager)

Nguồn: https://nssm.cc/release/nssm-2.24.zip
SHA256 (nssm.exe win64): f689ee9af94b00e9e3f0bb072b34caaf207f32dcb4f5782fc9ca351df9a06c97
License: Public domain (see LICENSE.txt).

Dùng để cài `betacom-agent.exe` làm Windows Service auto-start khi máy boot,
không cần user login. Installer Inno gọi:

```
nssm.exe install BetacomAgent "<install-dir>\betacom-agent.exe"
nssm.exe set BetacomAgent AppDirectory "<install-dir>"
nssm.exe set BetacomAgent Start SERVICE_AUTO_START
nssm.exe set BetacomAgent AppStdout "<install-dir>\logs\agent-stdout.log"
nssm.exe set BetacomAgent AppStderr "<install-dir>\logs\agent-stderr.log"
nssm.exe start BetacomAgent
```

Uninstall: `nssm.exe remove BetacomAgent confirm`.
