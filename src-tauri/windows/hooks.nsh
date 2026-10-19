; MiniMath NSIS installer hooks (Tauri bundle.windows.nsis.installerHooks).
;
; Registers the Word add-in for the installing user the way Office's own
; sideloading tool does: a value under WEF\Developer whose name is the
; add-in Id and whose data is the manifest path. Word picks it up the next
; time it starts. The uninstaller removes only MiniMath's own value.

!define MINIMATH_WEF_KEY "Software\Microsoft\Office\16.0\WEF\Developer"
!define MINIMATH_ADDIN_ID "6f0b7e7a-5d8e-4c1b-9a51-2f7c3b0d9e41"

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\addin\manifest.xml" 0 +2
    WriteRegStr HKCU "${MINIMATH_WEF_KEY}" "${MINIMATH_ADDIN_ID}" "$INSTDIR\addin\manifest.xml"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "${MINIMATH_WEF_KEY}" "${MINIMATH_ADDIN_ID}"
!macroend
