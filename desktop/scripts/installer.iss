; Paw Windows 安装包脚本（Inno Setup 6）
; 用法：
;   iscc /DMyAppVersion=1.0.0-rc.2 /DSourceDir=pack\Paw-win32-x64 /DOutputDir=pack /DOutputBaseFilename=Paw-v1.0.0-rc.2-windows-x64-setup desktop\scripts\installer.iss

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\pack\Paw-win32-x64"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\pack"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "Paw-windows-x64-setup"
#endif

[Setup]
AppId={{8F5E3B9A-2C41-4D7E-9A1B-6C8D0E2F4A7B}
AppName=Paw
AppVersion={#MyAppVersion}
AppVerName=Paw {#MyAppVersion}
AppPublisher=Paw
AppPublisherURL=https://github.com/CBQZOVO/PawAgent
DefaultDirName={autopf}\Paw
DefaultGroupName=Paw
UninstallDisplayIcon={app}\Paw.exe
SetupIconFile=..\assets\Paw.ico
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
CloseApplications=yes
DisableProgramGroupPage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Paw"; Filename: "{app}\Paw.exe"
Name: "{autodesktop}\Paw"; Filename: "{app}\Paw.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Paw.exe"; Description: "{cm:LaunchProgram,Paw}"; Flags: nowait postinstall skipifsilent
