; Personalización del instalador de Windows (NSIS), incluida desde package.json → build.nsis.include.
; electron-builder carga este archivo antes que MUI2, así que los !define de colores aplican a todas las páginas.

; ---------- Colores de la app (tema oscuro) ----------
; Cabecera, bienvenida y pantalla final: fondo y texto como la interfaz.
!define MUI_BGCOLOR "16171B"
!define MUI_TEXTCOLOR "F2F2F4"
; Registro de instalación: texto claro sobre fondo oscuro.
!define MUI_INSTFILESPAGE_COLORS "F2F2F4 16171B"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

; ---------- Barra de progreso naranja ----------
; electron-builder inserta este macro justo antes de MUI_PAGE_INSTFILES, así que el SHOW aplica a esa página.
; Sin estilo visual, la barra acepta colores (COLORREF = 0x00BBGGRR).
; PBM_SETBARCOLOR y PBM_SETBKCOLOR vienen de WinMessages.nsh (lo carga MUI2).

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW instFilesShow

  Function instFilesShow
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $0 $0 1004
    System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
    SendMessage $0 ${PBM_SETBARCOLOR} 0 0x003D6AFF ; #FF6A3D, acento de la app
    SendMessage $0 ${PBM_SETBKCOLOR} 0 0x00241F1E  ; #1E1F24, superficie oscura
  FunctionEnd
!macroend

; ---------- Bienvenida (usa installerSidebar.bmp) ----------
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Bienvenido a ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Prepara y revisa la transmisión en vivo y las pantallas antes del servicio: OBS, internet, audio, cámaras, proyector y más.$\r$\n$\r$\nHaz clic en Siguiente para continuar."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ---------- Pantalla final ----------
; Igual a la de electron-builder, más un ajuste: Windows ignora el color de texto de las casillas
; con estilo visual y "Ejecutar..." saldría negro sobre fondo oscuro. Sin estilo, toma MUI_TEXTCOLOR.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW finishPageShow
  !insertmacro MUI_PAGE_FINISH

  ; Va después de la página: $mui.FinishPage.Run se declara dentro de MUI_PAGE_FINISH.
  Function finishPageShow
    System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w " ", w " ")'
  FunctionEnd
!macroend

; ---------- Accesos directos ----------
; Los de la app quedan en la carpeta "Kerygma Live" del menú Inicio (menuCategory);
; electron-builder expone esa carpeta como MENU_FILENAME.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\Desinstalar ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\${MENU_FILENAME}\Desinstalar ${PRODUCT_NAME}.lnk"
  ; Solo se borra si quedó vacía.
  RMDir "$SMPROGRAMS\${MENU_FILENAME}"
!macroend
