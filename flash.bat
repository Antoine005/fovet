@echo off
title Fovet Flash Tool
echo.
echo  ===========================
echo   FOVET FLASH TOOL
echo  ===========================
echo.
echo  1. smoke_test
echo  2. fire_detection
echo  3. person_detection
echo  4. zscore_demo
echo.
set /p CHOIX= Choix (1-4) :

if "%CHOIX%"=="1" goto flash_smoke
if "%CHOIX%"=="2" goto flash_fire
if "%CHOIX%"=="3" goto flash_person
if "%CHOIX%"=="4" goto flash_zscore
echo Choix invalide.
goto fin

:flash_smoke
set ENV=smoke
set PROJ=D:\fovet\edge-core\examples\esp32\smoke_test
goto do_flash

:flash_fire
set ENV=fire_detection
set PROJ=D:\fovet\edge-core\examples\esp32\fire_detection
goto do_flash

:flash_person
set ENV=person_detection
set PROJ=D:\fovet\edge-core\examples\esp32\person_detection
goto do_flash

:flash_zscore
set ENV=esp32cam
set PROJ=D:\fovet\edge-core\examples\esp32\zscore_demo
goto do_flash

:do_flash
echo.
echo Flashage : %ENV%
echo Dossier  : %PROJ%
echo.
if not exist "%PROJ%" (
  echo ERREUR : dossier introuvable.
  goto fin
)
cd /d "%PROJ%"
set PIO=%USERPROFILE%\.platformio\penv\Scripts\pio.exe
if not exist "%PIO%" (
  echo ERREUR : pio.exe introuvable.
  goto fin
)
"%PIO%" run -e %ENV% --target upload
echo.
set /p MON= Ouvrir monitor serie ? (O/N) :
if /i "%MON%"=="O" "%PIO%" device monitor

:fin
echo.
pause
