; 保留应用运行期间创建的用户数据目录.
; 这些目录不随升级或卸载删除, 使重新安装后仍可继续使用原有设置和数据.

!macro preserveUserDirectory SOURCE NAME
  ${if} ${FileExists} "${SOURCE}\*.*"
    CreateDirectory "$preservedDataDir"
    ClearErrors
    Rename "${SOURCE}" "$preservedDataDir\${NAME}"
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法暂存用户数据. 安装或卸载已取消, 原数据未被删除."
      Quit
    ${endIf}
  ${endIf}
!macroend

!macro restoreUserDirectory NAME TARGET
  ${if} ${FileExists} "$preservedDataDir\${NAME}\*.*"
    CreateDirectory "${TARGET}"
    ClearErrors
    Rename "$preservedDataDir\${NAME}" "${TARGET}\${NAME}"
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法恢复用户数据. 数据仍保留在 $preservedDataDir 中."
      Quit
    ${endIf}
  ${endIf}
!macroend

!macro preserveUserData ROOT
  !insertmacro preserveUserDirectory "${ROOT}\resources\config" "config"
  !insertmacro preserveUserDirectory "${ROOT}\resources\mods" "mods"
  !insertmacro preserveUserDirectory "${ROOT}\resources\backups" "backups"
  !insertmacro preserveUserDirectory "${ROOT}\_storage" "_storage"
!macroend

!macro restoreUserData
  ${if} $preservedDataDir != ""
    !insertmacro restoreUserDirectory "config" "$INSTDIR\resources"
    !insertmacro restoreUserDirectory "mods" "$INSTDIR\resources"
    !insertmacro restoreUserDirectory "backups" "$INSTDIR\resources"
    !insertmacro restoreUserDirectory "_storage" "$INSTDIR"
    RMDir "$preservedDataDir"
  ${endIf}
!macroend

!macro removeElectronAppData
  ; Electron 的用户数据始终位于当前用户的 AppData.
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  RMDir /r "$APPDATA\${APP_FILENAME}"
  !ifdef APP_PRODUCT_FILENAME
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
  !endif
  !ifdef APP_PACKAGE_NAME
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
  !endif
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

; 自动更新始终保留数据. 普通卸载时由用户选择保留或完全删除.
!macro customUnInstall
  Var /GLOBAL keepUserData
  StrCpy $keepUserData "0"

  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${if} ${Errors}
    ${if} ${isUpdated}
      StrCpy $keepUserData "1"
    ${else}
      ClearErrors
      ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
      ${ifNot} ${Errors}
        StrCpy $keepUserData "1"
      ${else}
        ClearErrors
        ${GetOptions} $R0 "--keep-app-data" $R1
        ${ifNot} ${Errors}
          StrCpy $keepUserData "1"
        ${else}
          ${ifNot} ${Silent}
            !define UninstallChoiceId ${__LINE__}
            MessageBox MB_YESNO|MB_ICONQUESTION "是否保留设置、模组、备份和存档？$\r$\n选择“是”将仅卸载程序. 选择“否”将完全删除所有数据." IDYES keepData_${UninstallChoiceId} IDNO removeData_${UninstallChoiceId}
            keepData_${UninstallChoiceId}:
              StrCpy $keepUserData "1"
              Goto uninstallChoiceDone_${UninstallChoiceId}
            removeData_${UninstallChoiceId}:
              StrCpy $keepUserData "0"
            uninstallChoiceDone_${UninstallChoiceId}:
            !undef UninstallChoiceId
          ${endIf}
        ${endIf}
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

; 根据用户选择保留数据, 或执行完全卸载.
!macro customRemoveFiles
  Var /GLOBAL preservedDataDir

  ${if} $keepUserData == "1"
    StrCpy $preservedDataDir "$INSTDIR.__preserved"
    !insertmacro preserveUserData "$INSTDIR"

    SetOutPath $TEMP
    RMDir /r "$INSTDIR"

    !insertmacro restoreUserData
  ${else}
    SetOutPath $TEMP
    RMDir /r "$INSTDIR"
    RMDir /r "$INSTDIR.__preserved"
    !insertmacro removeElectronAppData
  ${endIf}
!macroend
