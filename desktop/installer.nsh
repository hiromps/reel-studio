; A new resource path avoids reusing the previous Windows icon cache entry.
; Keep shortcuts only when the installer/user chose to create or keep them.
!macro customInstall
  ${if} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\reel-studio-v2.ico" 0
  ${endif}
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\reel-studio-v2.ico" 0
  ${endif}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
