@echo off
setlocal

echo ==============================================
echo   Fovet SDK -- Demarrage de l'environnement
echo ==============================================

:: --- Chargement de .env.local ---
if not exist "D:\fovet\.env.local" (
    echo [WARN] .env.local introuvable -- variables MQTT non chargees
) else (
    for /f "usebackq tokens=1,* delims==" %%A in ("D:\fovet\.env.local") do (
        set "%%A=%%B"
    )
    echo [OK] .env.local charge
)

:: --- Mosquitto ---
echo.
echo [1/4] Demarrage Mosquitto...
tasklist /FI "IMAGENAME eq mosquitto.exe" 2>nul | find /I "mosquitto.exe" >nul
if %errorlevel%==0 (
    echo [OK] Mosquitto deja en cours d'execution
) else (
    start "Mosquitto" /B "C:\Program Files\Mosquitto\mosquitto.exe" -c "C:\Program Files\Mosquitto\mosquitto.conf"
    echo [OK] Mosquitto lance
)
timeout /t 2 /nobreak >nul

:: --- MQTT Listener ---
echo.
echo [2/4] Demarrage MQTT Listener...
if exist "D:\fovet\scripts\vigie_mqtt_listener.py" (
    start "MQTT Listener" cmd /k "set MQTT_BROKER=%MQTT_BROKER%& set MQTT_PORT=%MQTT_PORT%& set MQTT_USER=%MQTT_USER%& set MQTT_PASSWORD=%MQTT_PASSWORD%& C:\Users\Antoine\AppData\Local\Programs\Python\Python313\Scripts\uv.exe run --with paho-mqtt D:\fovet\scripts\vigie_mqtt_listener.py"
    echo [OK] MQTT Listener lance
) else (
    echo [WARN] scripts\vigie_mqtt_listener.py introuvable -- listener ignore
)

:: --- Kill node.js existants (evite lock Next.js) ---
taskkill /F /IM node.exe /T 2>nul

:: --- VIGIE (Next.js) ---
echo.
echo [3/4] Demarrage VIGIE...
if exist "D:\fovet\platform-dashboard\" (
    start "VIGIE" cmd /k "cd /d D:\fovet\platform-dashboard && npm run dev"
    echo [OK] VIGIE lance dans platform-dashboard/
) else (
    echo [WARN] D:\fovet\platform-dashboard\ introuvable -- VIGIE ignore
)

:: --- Navigateur ---
echo.
echo [4/4] Ouverture du navigateur dans 5 secondes...
timeout /t 5 /nobreak >nul
start http://localhost:3000

echo.
echo ==============================================
echo   Fovet demarre !
echo   Ctrl+C dans chaque fenetre pour arreter.
echo ==============================================
endlocal
