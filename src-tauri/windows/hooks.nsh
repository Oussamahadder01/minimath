; MiniMath NSIS installer hooks (Tauri bundle.windows.nsis.installerHooks).
;
; 1. Register the Word add-in for the installing user the way Office's own
;    sideloading tool does: a value under WEF\Developer whose name is the
;    add-in Id and whose data is the manifest path.
; 2. Registration only lists the add-in; Word starts it (and keeps its ribbon
;    button) once a document references it. So after an interactive install,
;    open "MiniMath dans Word.docx", which carries that reference, if Word is
;    installed. A Start menu shortcut reopens it later.
; The uninstaller removes only what these hooks created.

!define MINIMATH_WEF_KEY "Software\Microsoft\Office\16.0\WEF\Developer"
!define MINIMATH_ADDIN_ID "6f0b7e7a-5d8e-4c1b-9a51-2f7c3b0d9e41"
!define MINIMATH_ACTIVATION_DOC "$INSTDIR\addin\MiniMath dans Word.docx"
!define MINIMATH_ACTIVATION_LINK "$SMPROGRAMS\MiniMath - Activer dans Word.lnk"
!define MINIMATH_WORD_APP_PATH "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Winword.exe"

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\addin\manifest.xml" 0 minimath_no_manifest
    WriteRegStr HKCU "${MINIMATH_WEF_KEY}" "${MINIMATH_ADDIN_ID}" "$INSTDIR\addin\manifest.xml"
  minimath_no_manifest:

  IfFileExists "${MINIMATH_ACTIVATION_DOC}" 0 minimath_done
    ; Read-only, so Word never offers to save over the installed copy.
    SetFileAttributes "${MINIMATH_ACTIVATION_DOC}" READONLY
    CreateShortCut "${MINIMATH_ACTIVATION_LINK}" "${MINIMATH_ACTIVATION_DOC}"
    IfSilent minimath_done

    ; Is Word installed? Check both registry views (32/64-bit Office).
    SetRegView 64
    ReadRegStr $0 HKLM "${MINIMATH_WORD_APP_PATH}" ""
    SetRegView 32
    StrCmp $0 "" 0 +2
      ReadRegStr $0 HKLM "${MINIMATH_WORD_APP_PATH}" ""
    SetRegView default ; Tauri's installer never changes the view
    StrCmp $0 "" minimath_done
      ExecShell "open" "${MINIMATH_ACTIVATION_DOC}"
  minimath_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "${MINIMATH_WEF_KEY}" "${MINIMATH_ADDIN_ID}"
  Delete "${MINIMATH_ACTIVATION_LINK}"
  SetFileAttributes "${MINIMATH_ACTIVATION_DOC}" NORMAL
!macroend
