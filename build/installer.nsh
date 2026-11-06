; 保留应用运行期间写入的全部 resources 内容和存档目录.
; 程序包本身会被丢弃, 由新版本安装程序重新写入.

!define PRESERVED_INSTALL_PREFERENCES_KEY "Software\${APP_GUID}\PreservedInstallPreferences"

!macro isPackagedRootEntry ENTRY RESULT
  StrCpy ${RESULT} "0"
  ${if} "${ENTRY}" == "resources"
  ${orIf} "${ENTRY}" == "locales"
  ${orIf} "${ENTRY}" == "${APP_EXECUTABLE_FILENAME}"
  ${orIf} "${ENTRY}" == "${UNINSTALL_FILENAME}"
  ${orIf} "${ENTRY}" == "uninstallerIcon.ico"
  ${orIf} "${ENTRY}" == "chrome_100_percent.pak"
  ${orIf} "${ENTRY}" == "chrome_200_percent.pak"
  ${orIf} "${ENTRY}" == "d3dcompiler_47.dll"
  ${orIf} "${ENTRY}" == "dxcompiler.dll"
  ${orIf} "${ENTRY}" == "electron_wer.dll"
  ${orIf} "${ENTRY}" == "ffmpeg.dll"
  ${orIf} "${ENTRY}" == "icudtl.dat"
  ${orIf} "${ENTRY}" == "LICENSE.electron.txt"
  ${orIf} "${ENTRY}" == "LICENSES.chromium.html"
  ${orIf} "${ENTRY}" == "resources.pak"
  ${orIf} "${ENTRY}" == "snapshot_blob.bin"
  ${orIf} "${ENTRY}" == "v8_context_snapshot.bin"
  ${orIf} "${ENTRY}" == "vk_swiftshader.dll"
  ${orIf} "${ENTRY}" == "vk_swiftshader_icd.json"
  ${orIf} "${ENTRY}" == "vulkan-1.dll"
    StrCpy ${RESULT} "1"
  ${endIf}
!macroend

!macro preserveRootUserData ROOT
  !define PreserveRootUserDataId ${__LINE__}
  FindFirst $R0 $R1 "${ROOT}\*"
  preserveRootUserDataLoop_${PreserveRootUserDataId}:
    StrCmp $R1 "" preserveRootUserDataDone_${PreserveRootUserDataId}
    StrCmp $R1 "." preserveRootUserDataNext_${PreserveRootUserDataId}
    StrCmp $R1 ".." preserveRootUserDataNext_${PreserveRootUserDataId}
    !insertmacro isPackagedRootEntry "$R1" $R2
    ${if} $R2 == "0"
      CreateDirectory "$preservedDataDir\root"
      ClearErrors
      Rename "${ROOT}\$R1" "$preservedDataDir\root\$R1"
      ${if} ${Errors}
        StrCpy $preserveUserDataFailed "1"
        Goto preserveRootUserDataDone_${PreserveRootUserDataId}
      ${endIf}
    ${endIf}
  preserveRootUserDataNext_${PreserveRootUserDataId}:
    FindNext $R0 $R1
    Goto preserveRootUserDataLoop_${PreserveRootUserDataId}
  preserveRootUserDataDone_${PreserveRootUserDataId}:
    FindClose $R0
  !undef PreserveRootUserDataId
!macroend

!macro restoreRootUserData
  !define RestoreRootUserDataId ${__LINE__}
  ${if} ${FileExists} "$preservedDataDir\root\."
    FindFirst $R0 $R1 "$preservedDataDir\root\*"
    restoreRootUserDataLoop_${RestoreRootUserDataId}:
      StrCmp $R1 "" restoreRootUserDataDone_${RestoreRootUserDataId}
      StrCmp $R1 "." restoreRootUserDataNext_${RestoreRootUserDataId}
      StrCmp $R1 ".." restoreRootUserDataNext_${RestoreRootUserDataId}
      CreateDirectory "$INSTDIR"
      ClearErrors
      Rename "$preservedDataDir\root\$R1" "$INSTDIR\$R1"
      ${if} ${Errors}
        StrCpy $restoreUserDataFailed "1"
      ${endIf}
    restoreRootUserDataNext_${RestoreRootUserDataId}:
      FindNext $R0 $R1
      Goto restoreRootUserDataLoop_${RestoreRootUserDataId}
    restoreRootUserDataDone_${RestoreRootUserDataId}:
      FindClose $R0
    ${if} $restoreUserDataFailed == "0"
      RMDir "$preservedDataDir\root"
    ${endIf}
  ${endIf}
  !undef RestoreRootUserDataId
!macroend

!macro preserveUserDirectory SOURCE NAME
  ${if} $preserveUserDataFailed == "0"
    ; 使用目录本身判断, 空目录也必须被保留.
    ${if} ${FileExists} "${SOURCE}\."
      CreateDirectory "$preservedDataDir"
      ClearErrors
      Rename "${SOURCE}" "$preservedDataDir\${NAME}"
      ${if} ${Errors}
        StrCpy $preserveUserDataFailed "1"
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

!macro restoreUserDirectory NAME TARGET
  ${if} ${FileExists} "$preservedDataDir\${NAME}\."
    CreateDirectory "${TARGET}"
    ClearErrors
    Rename "$preservedDataDir\${NAME}" "${TARGET}\${NAME}"
    ${if} ${Errors}
      StrCpy $restoreUserDataFailed "1"
    ${endIf}
  ${endIf}
!macroend

!macro preserveUserData ROOT
  ; 先整体移动 resources, 以保留未来新增的数据文件和空目录.
  !insertmacro preserveUserDirectory "${ROOT}\resources" "resources"
  !insertmacro preserveUserDirectory "${ROOT}\_storage" "_storage"
  ${if} $preserveUserDataFailed == "0"
    !insertmacro preserveRootUserData "${ROOT}"
  ${endIf}
!macroend

; 仅移除 electron-builder 写入的程序资源; 其余 resources 内容均按用户数据保留.
; 必须在用户数据恢复成功后再调用, 以便更新失败时仍可完整回滚旧版本.
!macro removePackagedResources ROOT
  Delete "${ROOT}\app.asar"
  RMDir /r "${ROOT}\app.asar.unpacked"
  Delete "${ROOT}\app-update.yml"
  Delete "${ROOT}\elevate.exe"
!macroend

!macro restoreUserData
  ${if} $preservedDataDir != ""
    StrCpy $restoreUserDataFailed "0"
    !insertmacro restoreUserDirectory "resources" "$INSTDIR"
    !insertmacro restoreUserDirectory "_storage" "$INSTDIR"
    !insertmacro restoreRootUserData
    ${if} $restoreUserDataFailed == "0"
      RMDir "$preservedDataDir"
    ${endIf}
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

; 保留卸载后, electron-builder 会删除自己的安装注册表项.
; 单独保存模式与目录, 以便下一次安装仍能作为同一安装类型、在同一位置继续安装.
!macro customInit
  Var /GLOBAL preservedInstallMode
  Var /GLOBAL preservedInstallLocation

  ReadRegStr $preservedInstallMode HKCU "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallMode"
  ReadRegStr $preservedInstallLocation HKCU "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallLocation"
  ${if} $preservedInstallMode == ""
    ReadRegStr $preservedInstallMode HKLM "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallMode"
    ReadRegStr $preservedInstallLocation HKLM "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallLocation"
  ${endIf}

  ${if} $preservedInstallLocation != ""
    ${if} $preservedInstallMode == "all"
      StrCpy $installMode "all"
      StrCpy $hasPerMachineInstallation "1"
      StrCpy $hasPerUserInstallation "0"
      SetShellVarContext all
      ; 外层安装器尚未提升时无法写入 HKLM; 提升后的内层安装器会再次执行这里.
      ${if} ${UAC_IsAdmin}
        WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$preservedInstallLocation"
        WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "PreservedInstallPreference" "1"
      ${endIf}
    ${elseIf} $preservedInstallMode == "CurrentUser"
      StrCpy $installMode "CurrentUser"
      StrCpy $hasPerMachineInstallation "0"
      StrCpy $hasPerUserInstallation "1"
      SetShellVarContext current
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$preservedInstallLocation"
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "PreservedInstallPreference" "1"
    ${endIf}
  ${endIf}
!macroend

!macro customInstall
  ; 更新偏好为本次实际选择, 并仅清理由 customInit 临时创建的旧安装键.
  ${if} $installMode == "all"
    WriteRegStr HKLM "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallMode" "all"
    WriteRegStr HKLM "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallLocation" "$INSTDIR"
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" "PreservedInstallPreference"
    ${if} $R0 == "1"
      DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    ${endIf}
  ${else}
    WriteRegStr HKCU "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallMode" "CurrentUser"
    WriteRegStr HKCU "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallLocation" "$INSTDIR"
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" "PreservedInstallPreference"
    ${if} $R0 == "1"
      DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
    ${endIf}
  ${endIf}
!macroend

; 交互式卸载页: 默认保留数据, 仅在用户明确勾选后完全删除.
!macro customUnWelcomePage
  Var /GLOBAL completeUninstallRequested
  Var /GLOBAL completeUninstallCheckbox

  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.completeUninstallPre un.completeUninstallLeave

  Function un.completeUninstallPre
    ${if} ${Silent}
      Abort
    ${endIf}

    !insertmacro MUI_HEADER_TEXT "卸载选项" "默认仅卸载程序并保留用户数据"
    StrCpy $completeUninstallRequested "0"
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endIf}

    ${NSD_CreateLabel} 0 0 100% 24u "默认会保留设置、模组、备份、存档和安装偏好。"
    Pop $0
    ${NSD_CreateCheckbox} 0 34u 100% 18u "完全卸载（删除所有用户数据）"
    Pop $completeUninstallCheckbox
    ${NSD_SetState} $completeUninstallCheckbox ${BST_UNCHECKED}
    ${NSD_CreateLabel} 0 58u 100% 32u "勾选后将删除设置、模组、备份、存档、Electron AppData 和已保存的安装位置。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function un.completeUninstallLeave
    ${NSD_GetState} $completeUninstallCheckbox $0
    ${if} $0 == ${BST_CHECKED}
      StrCpy $completeUninstallRequested "1"
    ${else}
      StrCpy $completeUninstallRequested "0"
    ${endIf}
  FunctionEnd
!macroend

; 自动更新及未指定参数的静默卸载均保留数据. 普通卸载时由用户选择保留或完全删除.
!macro customUnInstall
  Var /GLOBAL removeElectronAppDataManually
  ; 与 deleteAppDataOnUninstall: false 保持一致: 静默卸载默认不删除用户数据.
  StrCpy $keepUserData "1"
  ; --delete-app-data 由 electron-builder 的后续卸载模板处理, 避免重复删除.
  StrCpy $removeElectronAppDataManually "0"

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
          ${if} $completeUninstallRequested == "1"
            StrCpy $keepUserData "0"
            ; 此分支没有 --delete-app-data 参数, 由本脚本清理 Electron 数据.
            StrCpy $removeElectronAppDataManually "1"
          ${endIf}
        ${endIf}
      ${endIf}
    ${endIf}
  ${endIf}

!macroend

; 根据用户选择保留数据, 或执行完全卸载.
!macro customRemoveFiles
  Var /GLOBAL preservedDataDir
  Var /GLOBAL preserveUserDataFailed
  Var /GLOBAL restoreUserDataFailed

  ${if} $keepUserData == "1"
    StrCpy $preservedDataDir "$INSTDIR.__preserved"
    StrCpy $preserveUserDataFailed "0"
    !insertmacro preserveUserData "$INSTDIR"

    ${if} $preserveUserDataFailed != "0"
      ; 已移动的目录必须先移回, 否则失败会把用户数据留在临时目录中.
      !insertmacro restoreUserData
      ${if} $restoreUserDataFailed != "0"
        MessageBox MB_OK|MB_ICONEXCLAMATION "无法暂存用户数据, 且自动恢复未完成. 未恢复的数据仍保留在 $preservedDataDir 中."
      ${else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "无法暂存用户数据. 已恢复原有数据, 安装或卸载已取消."
      ${endIf}
      Abort
    ${endIf}

    ; 保留 electron-builder 更新时的原子删除与失败回滚逻辑.
    ; 失败时先还原程序文件, 再还原已暂存的用户数据.
    ${if} ${isUpdated}
      CreateDirectory "$PLUGINSDIR\old-install"
      Push ""
      Call un.atomicRMDir
      Pop $R0

      ${if} $R0 != 0
        Push ""
        Call un.restoreFiles
        Pop $R0
        !insertmacro restoreUserData
        ${if} $restoreUserDataFailed != "0"
          MessageBox MB_OK|MB_ICONEXCLAMATION "更新取消. 程序文件已尝试还原; 未恢复的用户数据仍保留在 $preservedDataDir 中."
        ${else}
          MessageBox MB_OK|MB_ICONEXCLAMATION "更新取消. 原程序和用户数据已还原."
        ${endIf}
        Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
      ${endIf}
    ${endIf}

    SetOutPath $TEMP
    RMDir /r "$INSTDIR"
    !insertmacro restoreUserData
    ${if} $restoreUserDataFailed != "0"
      ; 更新尚未写入新版本, 可将原程序一并还原.
      ${if} ${isUpdated}
        Push ""
        Call un.restoreFiles
        Pop $R0
      ${endIf}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法恢复用户数据. 未恢复的数据仍保留在 $preservedDataDir 中. 卸载已取消."
      Abort
    ${endIf}
    !insertmacro removePackagedResources "$INSTDIR\resources"
  ${else}
    SetOutPath $TEMP
    RMDir /r "$INSTDIR"
    RMDir /r "$INSTDIR.__preserved"
    ${if} $removeElectronAppDataManually == "1"
      !insertmacro removeElectronAppData
    ${endIf}
  ${endIf}
!macroend

; electron-builder 已删除 ${INSTALL_REGISTRY_KEY} 后触发.
; 使用卸载成功回调而非 customUnInstallSection, 避免额外的组件选择页.
!macro customHeader
  !ifdef BUILD_UNINSTALLER
  Var /GLOBAL keepUserData
  Function un.onUninstSuccess
    ${if} $keepUserData == "1"
      ${if} $installMode == "all"
        WriteRegStr HKLM "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallMode" "all"
        WriteRegStr HKLM "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallLocation" "$INSTDIR"
      ${else}
        WriteRegStr HKCU "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallMode" "CurrentUser"
        WriteRegStr HKCU "${PRESERVED_INSTALL_PREFERENCES_KEY}" "InstallLocation" "$INSTDIR"
      ${endIf}
    ${endIf}
  FunctionEnd
  !endif
!macroend
