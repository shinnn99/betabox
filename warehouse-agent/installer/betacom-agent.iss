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
#define AppVersion     "0.2.0"
#define AppPublisher   "Betacom"
#define AppURL         "https://betabox.vercel.app"
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

[Dirs]
Name: "{app}\logs";        Permissions: users-modify
Name: "{app}\data";        Permissions: users-modify

[Code]
var
  ConfigPage: TInputQueryWizardPage;
  RecordingPage: TInputDirWizardPage;

procedure InitializeWizard;
begin
  ConfigPage := CreateInputQueryPage(wpSelectDir,
    'Cấu hình Agent',
    'Nhập thông tin đăng ký agent',
    'Lấy từ Dashboard admin → Warehouse agents. Không được để trống.');
  ConfigPage.Add('BACKEND_URL (VD: https://betabox.vercel.app):', False);
  ConfigPage.Add('AGENT_CODE (VD: AGENT_KHO_HN_01):', False);
  ConfigPage.Add('AGENT_SECRET (secret dài, chuỗi hex):', True);
  ConfigPage.Values[0] := 'https://betabox.vercel.app';

  RecordingPage := CreateInputDirPage(ConfigPage.ID,
    'Thư mục lưu video',
    'Chọn ổ đĩa lớn (≥500GB) — không phải ổ C:',
    'Agent sẽ ghi segment .mp4 vào đây. Đề xuất: D:\beta_cam_recordings',
    False, 'BetacomAgent');
  RecordingPage.Add('');
  RecordingPage.Values[0] := 'D:\beta_cam_recordings';
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

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    WriteEnvFile;
    ConfigureNTP;
    InstallService;
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
  end;
end;

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\data"
Type: files; Name: "{app}\.env"
