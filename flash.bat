@echo off
setlocal enabledelayedexpansion

echo.
echo ==========================================
echo   Fovet Flash Tool
echo ==========================================
echo.
echo   1. smoke_test        (Z-Score sinus synthetique, UART CSV)
echo   2. fire_detection    (OV2640 RGB565 + Z-Score, detection feu/fumee)
echo   3. person_detection  (TFLite Micro VWW + Z-Score, detection personne)
echo   4. zscore_demo       (Z-Score + Drift + MQTT vers Vigie)
echo.
set /p CHOIX="Choix (1-4) : "

if "%CHOIX%"=="1" (
    set "FIRMWARE_DIR=D:\fovet\edge-core\examples\esp32\smoke_test"
    set "PIO_ENV=smoke"
    set "FIRMWARE_NAME=smoke_test"
) else if "%CHOIX%"=="2" (
    set "FIRMWARE_DIR=D:\fovet\edge-core\examples\esp32\fire_detection"
    set "PIO_ENV=fire_detection"
    set "FIRMWARE_NAME=fire_detection"
) else if "%CHOIX%"=="3" (
    set "FIRMWARE_DIR=D:\fovet\edge-core\examples\esp32\person_detection"
    set "PIO_ENV=person_detection"
    set "FIRMWARE_NAME=person_detection"
) else if "%CHOIX%"=="4" (
    set "FIRMWARE_DIR=D:\fovet\edge-core\examples\esp32\zscore_demo"
    set "PIO_ENV=esp32cam"
    set "FIRMWARE_NAME=zscore_demo"
) else (
    echo [ERREUR] Choix invalide : "%CHOIX%"
    pause
    exit /b 1
)

echo.
echo [INFO] Firmware selectionne : %FIRMWARE_NAME%
echo [INFO] Repertoire           : %FIRMWARE_DIR%
echo [INFO] Environnement PIO    : %PIO_ENV%
echo.

:: Verification du repertoire
if not exist "%FIRMWARE_DIR%\" (
    echo [ERREUR] Dossier introuvable : %FIRMWARE_DIR%
    pause
    exit /b 1
)

:: Localisation de PlatformIO
:: 1. Essai via PATH (VS Code terminal, shell configure)
set "PIO_CMD=pio"
where pio >nul 2>&1
if errorlevel 1 (
    :: 2. Emplacement par defaut de l'installeur PlatformIO Core
    set "PIO_LOCAL=%USERPROFILE%\.platformio\penv\Scripts\pio.exe"
    if exist "!PIO_LOCAL!" (
        set "PIO_CMD=!PIO_LOCAL!"
        echo [INFO] PlatformIO trouve : !PIO_LOCAL!
    ) else (
        echo [ERREUR] PlatformIO (pio) introuvable.
        echo          Chemins testes :
        echo            - PATH systeme
        echo            - %USERPROFILE%\.platformio\penv\Scripts\pio.exe
        echo.
        echo          Solutions :
        echo            - Installez PlatformIO VS Code extension et relancez
        echo            - Ou lancez ce script depuis un terminal VS Code
        pause
        exit /b 1
    )
)

:: Flash
echo [FLASH] Compilation + upload en cours...
echo.
cd /d "%FIRMWARE_DIR%"
"%PIO_CMD%" run -e %PIO_ENV% --target upload
set "FLASH_CODE=%errorlevel%"

if not "%FLASH_CODE%"=="0" (
    echo.
    echo [ERREUR] Flash echoue (code %FLASH_CODE%).
    echo          Verifiez : port COM4 libre, adaptateur CH340 branche, IO0 a GND pendant le reset.
    pause
    exit /b %FLASH_CODE%
)

echo.
echo [OK] Flash termine avec succes.
echo.

:: Proposition moniteur serie
set /p MONITOR="Ouvrir le moniteur serie ? (O/N) : "
if /i "%MONITOR%"=="O" (
    echo [INFO] Ouverture du moniteur serie (Ctrl+C pour quitter)...
    "%PIO_CMD%" device monitor -e %PIO_ENV%
)

echo.
echo [OK] Termine.
echo.
pause
endlocal
