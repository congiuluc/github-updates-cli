#ifndef AppVersion
#define AppVersion "1.0.0"
#endif
#ifndef SourceDir
#define SourceDir "..\artifacts\copilot-changelog-win-x64"
#endif

[Setup]
AppId={{AD667075-8C1E-4CDB-91CC-E7DB68A5C6AE}
AppName=Copilot Changelog CLI
AppVersion={#AppVersion}
AppPublisher=Copilot Changelog CLI
DefaultDirName={localappdata}\Programs\Copilot Changelog CLI
DisableProgramGroupPage=yes
OutputDir=..\artifacts
OutputBaseFilename=copilot-changelog-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
ChangesEnvironment=yes
SetupIconFile=..\assets\copilot.ico
UninstallDisplayIcon={app}\copilot-changelog.exe

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "output\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Icons]
Name: "{group}\Copilot Changelog CLI"; Filename: "{cmd}"; Parameters: "/k ""{app}\copilot-changelog.exe --help"""; IconFilename: "{app}\copilot-changelog.exe"; IconIndex: 0

[Code]
function NeedsAddPath(Param: string): Boolean;
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then
    Result := True
  else
    Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(Paths) + ';') = 0;
end;

procedure RemovePath(Param: string);
var
  Paths: string;
  Entry: string;
  UpdatedPaths: string;
  SeparatorPosition: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then
    Exit;

  while Paths <> '' do
  begin
    SeparatorPosition := Pos(';', Paths);
    if SeparatorPosition = 0 then
    begin
      Entry := Paths;
      Paths := '';
    end
    else
    begin
      Entry := Copy(Paths, 1, SeparatorPosition - 1);
      Delete(Paths, 1, SeparatorPosition);
    end;

    if CompareText(Trim(Entry), Param) <> 0 then
    begin
      if UpdatedPaths <> '' then
        UpdatedPaths := UpdatedPaths + ';';
      UpdatedPaths := UpdatedPaths + Entry;
    end;
  end;

  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', UpdatedPaths);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemovePath(ExpandConstant('{app}'));
end;
