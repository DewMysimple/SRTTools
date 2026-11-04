; Dedicated HKCU verb only. Never touch associations, parent keys, or another installation.
!macro SRTToolsRepairVerb EXT
  ReadRegStr $R0 HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import" "Owner"
  ${If} $R0 == "com.subtitletools.desktop"
    ReadRegStr $R0 HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import" "Executable"
    ${If} $R0 == "$INSTDIR\${MAINBINARYNAME}.exe"
      WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import" "" "使用 Subtitle Tools 打开"
      WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import" "Icon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
      WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import" "MultiSelectModel" "Document"
      WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --import $\"%1$\"'
    ${EndIf}
  ${EndIf}
!macroend

!macro SRTToolsRemoveVerb EXT
  ReadRegStr $R0 HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import" "Owner"
  ${If} $R0 == "com.subtitletools.desktop"
    ReadRegStr $R0 HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import" "Executable"
    ${If} $R0 == "$INSTDIR\${MAINBINARYNAME}.exe"
      DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\SRTTools.Import"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  ; A fresh install does not register anything. Only repair this exact enabled installation.
  !insertmacro SRTToolsRepairVerb "srt"
  !insertmacro SRTToolsRepairVerb "vtt"
  !insertmacro SRTToolsRepairVerb "ass"
  !insertmacro SRTToolsRepairVerb "ssa"
  !insertmacro SRTToolsRepairVerb "txt"
  !insertmacro SRTToolsRepairVerb "csv"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $R0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $R0
  ; The updater retains the user's opt-in; same-path postinstall repairs its command.
  ${If} $UpdateMode != 1
    !insertmacro SRTToolsRemoveVerb "srt"
    !insertmacro SRTToolsRemoveVerb "vtt"
    !insertmacro SRTToolsRemoveVerb "ass"
    !insertmacro SRTToolsRemoveVerb "ssa"
    !insertmacro SRTToolsRemoveVerb "txt"
    !insertmacro SRTToolsRemoveVerb "csv"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  Pop $R0
!macroend
