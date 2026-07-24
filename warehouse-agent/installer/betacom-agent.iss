; ============================================================
; Betacom Warehouse Agent — Inno Setup script
; ============================================================
; Đóng gói 1 file .exe cài xong:
;   1. Copy binary (agent + ffmpeg + nssm) vào <ProgramFiles>\BetacomAgent
;   2. Prompt khách 4 field bắt buộc → ghi .env
;   3. Cấu hình NTP (w32time) tự động
;   4. Cài Windows Service "BetacomAgent" qua NSSM, start service
;
; Build: cd installer && "C:\Program Files (x86)\Inno Setup 6\iscc.exe" betacom-agent.iss
; hoặc chạy scripts\build-installer.ps1 ở root warehouse-agent.
;
; Yêu cầu file bên cạnh (relative to installer/):
;   ..\dist-exe\betacom-agent.exe
;   ..\dist-package\BetacomAgent\ffmpeg.exe
;   ..\dist-package\BetacomAgent\ffprobe.exe
;   ..\vendor\nssm\nssm.exe
;
; Chạy dưới quyền admin (PrivilegesRequired=admin) vì cần cài service +
; chỉnh w32time.

#define AppName        "Betacom Warehouse Agent"
#define AppVersion     "0.8.4"
#define AppPublisher   "Betacom"
#define AppURL         "https://betabox.betacom.agency"
#define ServiceName    "BetacomAgent"
#define AgentExe       "betacom-agent.exe"

[Setup]
AppId={{4F9E1A34-2B7C-4B62-9C5E-BETACOM-AGENT}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={autopf}\BetacomAgent
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputDir=..\dist-installer
OutputBaseFilename=BetacomAgentSetup-v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
UsePreviousAppDir=yes
UsePreviousSetupType=no
UsePreviousTasks=no
CloseApplications=force
RestartApplications=no
; Việt hoá bằng cách ép ngôn ngữ default Vietnamese (custom message ở [Messages] bên dưới).

[Languages]
Name: "vi"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist-exe\betacom-agent.exe";                        DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-package\BetacomAgent\ffmpeg.exe";              DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-package\BetacomAgent\ffprobe.exe";             DestDir: "{app}"; Flags: ignoreversion
Source: "..\vendor\nssm\nssm.exe";                              DestDir: "{app}"; Flags: ignoreversion
Source: "..\vendor\nssm\LICENSE.txt";                           DestDir: "{app}"; DestName: "NSSM-LICENSE.txt"; Flags: ignoreversion
Source: "..\scripts\cleanup-segments.ps1";                      DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\logs";        Permissions: users-modify
Name: "{app}\data";        Permissions: users-modify

[Code]
var
  ConfigPage: TInputQueryWizardPage;
  RecordingPage: TInputDirWizardPage;
  PrefillDone: Boolean;

// Đọc value của KEY trong 1 dòng KEY=VALUE. Trả '' nếu không phải dòng
// KEY này. Bỏ qua whitespace hai đầu, KHÔNG dùng hàm Trim nội bộ vì
// phần VALUE (VD RECORDING_DIR) có thể chứa space hợp lệ ở giữa.
function ParseEnvLine(const Line, Key: string): string;
var
  P: Integer;
  L, K, V: string;
begin
  Result := '';
  L := Line;
  // Skip comment lines
  if (Length(L) > 0) and (L[1] = '#') then exit;
  P := Pos('=', L);
  if P <= 1 then exit;
  K := Copy(L, 1, P - 1);
  V := Copy(L, P + 1, Length(L) - P);
  if CompareText(Trim(K), Key) = 0 then
    Result := V;
end;

// Đọc .env cũ (nếu upgrade in-place), tách 4 field, prefill wizard.
//
// Gọi ở CurPageChanged khi rời wpSelectDir — TẠI ĐÓ constant {app} đã
// được resolve (user vừa xác nhận install dir). Không gọi ở
// InitializeWizard vì lúc đó {app} chưa init → Runtime error "expand
// the 'app' constant before it was initialized".
//
// Idempotent qua flag PrefillDone để chỉ chạy 1 lần (user quay lại
// page wpSelectDir không reload đè lên input họ đang sửa).
//
// Về AGENT_SECRET: hiện ở page dưới dạng field password (echo=True), user
// KHÔNG nhìn thấy chuỗi thật nhưng vẫn giữ value đầu vào. Bấm Next mà
// không sửa = value cũ được giữ nguyên → không mất secret khi upgrade.
procedure TryLoadPreviousEnv;
var
  EnvPath, Line, V: string;
  Lines: TArrayOfString;
  i: Integer;
begin
  EnvPath := ExpandConstant('{app}\.env');
  if not FileExists(EnvPath) then exit;
  if not LoadStringsFromFile(EnvPath, Lines) then exit;

  for i := 0 to GetArrayLength(Lines) - 1 do begin
    Line := Lines[i];

    V := ParseEnvLine(Line, 'BACKEND_URL');
    if V <> '' then ConfigPage.Values[0] := V;

    V := ParseEnvLine(Line, 'AGENT_CODE');
    if V <> '' then ConfigPage.Values[1] := V;

    V := ParseEnvLine(Line, 'AGENT_SECRET');
    if V <> '' then ConfigPage.Values[2] := V;

    V := ParseEnvLine(Line, 'RECORDING_DIR');
    if V <> '' then begin
      // .env dùng forward slash D:/beta_cam_recordings; wizard hiển thị
      // dạng Windows D:\beta_cam_recordings để user quen mắt.
      StringChangeEx(V, '/', '\', True);
      RecordingPage.Values[0] := V;
    end;
  end;
end;

procedure InitializeWizard;
begin
  ConfigPage := CreateInputQueryPage(wpSelectDir,
    'Cấu hình Agent',
    'Nhập thông tin đăng ký agent',
    'Lấy từ Dashboard admin → Warehouse agents. Không được để trống.');
  ConfigPage.Add('BACKEND_URL (VD: https://betabox.betacom.agency):', False);
  ConfigPage.Add('AGENT_CODE (VD: AGENT_KHO_HN_01):', False);
  ConfigPage.Add('AGENT_SECRET (secret dài, chuỗi hex):', True);
  ConfigPage.Values[0] := 'https://betabox.betacom.agency';

  RecordingPage := CreateInputDirPage(ConfigPage.ID,
    'Thư mục lưu video',
    'Chọn ổ đĩa lớn (≥500GB) — không phải ổ C:',
    'Agent sẽ ghi segment .mp4 vào đây. Đề xuất: D:\beta_cam_recordings',
    False, 'BetacomAgent');
  RecordingPage.Add('');
  RecordingPage.Values[0] := 'D:\beta_cam_recordings';
  PrefillDone := False;
end;

// Fire khi wizard chuyển sang page mới. Dùng để prefill từ .env cũ
// SAU khi user đã xác nhận install dir (wpSelectDir Next), lúc đó
// constant {app} mới được resolve.
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = ConfigPage.ID) and (not PrefillDone) then begin
    // Upgrade in-place: nếu .env cũ tồn tại, prefill 4 field. User bấm
    // Next mà không đổi = ghi lại y nguyên → không mất secret/config
    // khi upgrade. Fix bug 2026-07-06: installer 0.2.0/0.3.0/0.3.1
    // luôn hỏi lại secret; và 0.3.2 crash với "expand app constant
    // before init" khi gọi ở InitializeWizard.
    TryLoadPreviousEnv;
    PrefillDone := True;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  BackendUrl, AgentCode, AgentSecret, RecDir: string;
begin
  Result := True;
  if CurPageID = ConfigPage.ID then begin
    BackendUrl := Trim(ConfigPage.Values[0]);
    AgentCode := Trim(ConfigPage.Values[1]);
    AgentSecret := Trim(ConfigPage.Values[2]);
    if (Pos('https://', BackendUrl) <> 1) and (Pos('http://', BackendUrl) <> 1) then begin
      MsgBox('BACKEND_URL phải bắt đầu bằng http:// hoặc https://', mbError, MB_OK);
      Result := False;
      exit;
    end;
    if Length(AgentCode) < 3 then begin
      MsgBox('AGENT_CODE tối thiểu 3 ký tự.', mbError, MB_OK);
      Result := False;
      exit;
    end;
    if Length(AgentSecret) < 16 then begin
      MsgBox('AGENT_SECRET tối thiểu 16 ký tự (secret ngắn dễ đoán).', mbError, MB_OK);
      Result := False;
      exit;
    end;
  end;
  if CurPageID = RecordingPage.ID then begin
    RecDir := Trim(RecordingPage.Values[0]);
    if (Length(RecDir) < 3) or (Pos(':', RecDir) <> 2) then begin
      MsgBox('Thư mục video không hợp lệ. Cần dạng D:\...', mbError, MB_OK);
      Result := False;
      exit;
    end;
    if (Uppercase(Copy(RecDir, 1, 2)) = 'C:') then begin
      if MsgBox('Bạn chọn ổ C:. Không khuyến nghị vì đầy ổ hệ thống sẽ treo máy. Vẫn tiếp tục?',
                mbConfirmation, MB_YESNO) = IDNO then begin
        Result := False;
        exit;
      end;
    end;
  end;
end;

procedure WriteEnvFile;
var
  Lines: TArrayOfString;
  RecDir: string;
begin
  RecDir := Trim(RecordingPage.Values[0]);
  StringChangeEx(RecDir, '\', '/', True);
  SetArrayLength(Lines, 8);
  Lines[0] := '# Sinh bởi BetacomAgentSetup — không sửa tay trừ khi biết đang làm gì.';
  Lines[1] := 'BACKEND_URL=' + Trim(ConfigPage.Values[0]);
  Lines[2] := 'AGENT_CODE=' + Trim(ConfigPage.Values[1]);
  Lines[3] := 'AGENT_SECRET=' + Trim(ConfigPage.Values[2]);
  Lines[4] := 'FFMPEG_PATH=./ffmpeg.exe';
  Lines[5] := 'FFPROBE_PATH=./ffprobe.exe';
  Lines[6] := 'RECORDING_DIR=' + RecDir;
  Lines[7] := 'SCANNERS_JSON=[]';
  SaveStringsToFile(ExpandConstant('{app}\.env'), Lines, False);
end;

function RunAndLog(const Cmd, Args: string): Integer;
var
  ResultCode: Integer;
begin
  Exec(Cmd, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode;
end;

procedure ConfigureNTP;
var
  ResultCode: Integer;
  Peers: string;
begin
  Peers := 'time.google.com,0x8 time.cloudflare.com,0x8 time.windows.com,0x8 vn.pool.ntp.org,0x8';
  Exec('sc.exe', 'config w32time start= auto', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('net.exe', 'start w32time', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('w32tm.exe', '/config /manualpeerlist:"' + Peers + '" /syncfromflags:manual /reliable:yes /update',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('net.exe', 'stop w32time', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('net.exe', 'start w32time', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('w32tm.exe', '/resync', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure InstallService;
var
  Nssm, App, LogOut, LogErr: string;
  ResultCode: Integer;
begin
  Nssm := ExpandConstant('{app}\nssm.exe');
  App := ExpandConstant('{app}\' + '{#AgentExe}');
  LogOut := ExpandConstant('{app}\logs\agent-stdout.log');
  LogErr := ExpandConstant('{app}\logs\agent-stderr.log');

  // Nếu service đã tồn tại (reinstall), gỡ trước.
  Exec(Nssm, 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'remove {#ServiceName} confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  Exec(Nssm, 'install {#ServiceName} "' + App + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppDirectory "' + ExpandConstant('{app}') + '"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} Start SERVICE_AUTO_START', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppStdout "' + LogOut + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppStderr "' + LogErr + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Restart khi crash: đợi 5s, thử tối đa 3 lần trong 60s.
  Exec(Nssm, 'set {#ServiceName} AppExit Default Restart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppRestartDelay 5000', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'start {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Task Scheduler task cleanup segment cũ.
//
// Chạy Chủ nhật 03:00 (thấp tải, không đè giờ ghi peak). Chạy dưới SYSTEM
// (cùng quyền service NSSM) để đọc .env + retention-cache.json trong
// {app}. Delay 5 phút sau khởi động máy (option "Delay task for") tránh
// đụng agent boot recovery scan trên HDD. Run-if-missed (kho tắt cuối
// tuần → chạy khi bật máy sáng thứ Hai).
//
// Idempotent: delete task cũ trước khi create (upgrade in-place hoặc
// reinstall).
procedure InstallCleanupTask;
var
  ScriptPath, WrapperPath, Ps1: string;
  ResultCode: Integer;
begin
  ScriptPath := ExpandConstant('{app}\cleanup-segments.ps1');
  WrapperPath := ExpandConstant('{app}\install-cleanup-task.ps1');

  // Xóa task cũ (nếu có) — bỏ qua lỗi (task chưa tồn tại).
  Exec('schtasks.exe', '/Delete /TN "BetacomAgentCleanup" /F',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // Gọi PowerShell tạo XML task + đăng ký. Không tạo XML tay trong Inno
  // Pascal vì:
  //   1. schtasks đòi UTF-16 LE + BOM (verify 2026-07-22, ca máy Betacom).
  //   2. Inno Pascal Script không có helper ghi UTF-16 sẵn (chỉ có
  //      SaveStringToFile ANSI + SaveStringsToUTF8File). Viết bytes tay
  //      qua stream phức tạp + dễ sai.
  // PowerShell .NET có [System.Text.Encoding]::Unicode + WriteAllText
  // rõ ràng, đúng chuẩn, đã kiểm hoạt động thật.
  //
  // XML content Y NGUYÊN VĂN như block workaround Hạnh chạy tay 2026-07-22.
  Ps1 :=
    '$xml = @''' + #13#10 +
    '<?xml version="1.0" encoding="UTF-16"?>' + #13#10 +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">' + #13#10 +
    '  <RegistrationInfo>' + #13#10 +
    '    <Description>Xoa video segment cu hon retention_days. Doc cache local, khong goi mang.</Description>' + #13#10 +
    '  </RegistrationInfo>' + #13#10 +
    '  <Triggers>' + #13#10 +
    '    <CalendarTrigger>' + #13#10 +
    '      <StartBoundary>2026-01-04T03:00:00</StartBoundary>' + #13#10 +
    '      <Enabled>true</Enabled>' + #13#10 +
    '      <ScheduleByWeek>' + #13#10 +
    '        <DaysOfWeek><Sunday /></DaysOfWeek>' + #13#10 +
    '        <WeeksInterval>1</WeeksInterval>' + #13#10 +
    '      </ScheduleByWeek>' + #13#10 +
    '    </CalendarTrigger>' + #13#10 +
    '  </Triggers>' + #13#10 +
    '  <Principals>' + #13#10 +
    '    <Principal id="Author">' + #13#10 +
    '      <UserId>S-1-5-18</UserId>' + #13#10 +
    '      <RunLevel>HighestAvailable</RunLevel>' + #13#10 +
    '    </Principal>' + #13#10 +
    '  </Principals>' + #13#10 +
    '  <Settings>' + #13#10 +
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>' + #13#10 +
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>' + #13#10 +
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>' + #13#10 +
    '    <AllowHardTerminate>true</AllowHardTerminate>' + #13#10 +
    '    <StartWhenAvailable>true</StartWhenAvailable>' + #13#10 +
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>' + #13#10 +
    '    <IdleSettings>' + #13#10 +
    '      <StopOnIdleEnd>false</StopOnIdleEnd>' + #13#10 +
    '      <RestartOnIdle>false</RestartOnIdle>' + #13#10 +
    '    </IdleSettings>' + #13#10 +
    '    <AllowStartOnDemand>true</AllowStartOnDemand>' + #13#10 +
    '    <Enabled>true</Enabled>' + #13#10 +
    '    <Hidden>false</Hidden>' + #13#10 +
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>' + #13#10 +
    '    <WakeToRun>false</WakeToRun>' + #13#10 +
    '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>' + #13#10 +
    '    <Priority>7</Priority>' + #13#10 +
    '  </Settings>' + #13#10 +
    '  <Actions Context="Author">' + #13#10 +
    '    <Exec>' + #13#10 +
    '      <Command>powershell.exe</Command>' + #13#10 +
    '      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"</Arguments>' + #13#10 +
    '    </Exec>' + #13#10 +
    '  </Actions>' + #13#10 +
    '</Task>' + #13#10 +
    '''@' + #13#10 +
    '$xmlPath = "$env:TEMP\betacom-cleanup-task.xml"' + #13#10 +
    '[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)' + #13#10 +
    'schtasks /Create /TN "BetacomAgentCleanup" /XML $xmlPath /F' + #13#10 +
    'Remove-Item $xmlPath -Force' + #13#10 +
    'exit $LASTEXITCODE' + #13#10;

  // Ghi wrapper .ps1 ra {app} (installer Pascal ANSI OK cho ASCII).
  SaveStringToFile(WrapperPath, Ps1, False);

  // Chạy wrapper. Kiểm ResultCode để không quiet-fail.
  Exec('powershell.exe',
       '-NoProfile -ExecutionPolicy Bypass -File "' + WrapperPath + '"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then begin
    DeleteFile(WrapperPath);
  end else begin
    // GIỮ wrapper .ps1 để Hạnh chạy tay chẩn đoán.
    SaveStringToFile(
      ExpandConstant('{app}\logs\cleanup-task-install-failed.log'),
      'schtasks /Create fail with exit code ' + IntToStr(ResultCode) + #13#10 +
      'Wrapper script giu tai: ' + WrapperPath + #13#10 +
      'Chay tay de xem loi thuc: powershell -NoProfile -ExecutionPolicy Bypass -File "' + WrapperPath + '"' + #13#10,
      False
    );
  end;
end;

procedure StopServiceIfRunning;
var
  Nssm: string;
  ResultCode: Integer;
begin
  // Stop service NSSM nếu tồn tại → release lock file betacom-agent.exe/ffmpeg.exe
  // trước khi [Files] copy đè. Không dùng nssm.exe của bản mới (chưa copy)
  // — dùng nssm.exe của bản CŨ ở {app}\nssm.exe (upgrade in-place cùng
  // AppId + UsePreviousAppDir=yes).
  //
  // Fallback: sc stop trực tiếp nếu nssm.exe cũ mất (VD user xóa tay).
  // sc stop chờ tối đa 30s, đủ cho agent shutdown gracefully.
  Nssm := ExpandConstant('{app}\nssm.exe');
  if FileExists(Nssm) then begin
    Exec(Nssm, 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
  // Belt-and-suspenders: gọi sc stop dù nssm đã stop — vô hại nếu service
  // đã stopped, đảm bảo release lock khi nssm không tồn tại.
  Exec('sc.exe', 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Chờ ngắn cho Windows release file handle sau khi service stop.
  Sleep(2000);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then begin
    // TRƯỚC khi [Files] copy: stop service để release lock.
    // Fix bug 2026-07-06: "DeleteFile failed; code 5. Access is denied."
    // khi upgrade in-place vì service NSSM giữ lock trên betacom-agent.exe.
    StopServiceIfRunning;
  end;
  if CurStep = ssPostInstall then begin
    WriteEnvFile;
    ConfigureNTP;
    InstallService;
    InstallCleanupTask;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Nssm: string;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then begin
    Nssm := ExpandConstant('{app}\nssm.exe');
    Exec(Nssm, 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(Nssm, 'remove {#ServiceName} confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // Xóa Task Scheduler task cleanup (bỏ qua lỗi nếu không tồn tại).
    Exec('schtasks.exe', '/Delete /TN "BetacomAgentCleanup" /F',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\data"
Type: files; Name: "{app}\.env"
