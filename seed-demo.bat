@echo off
REM ---------------------------------------------------------------------------
REM  Seed the DEMO timetable data into BOTH environments, one dry run at a time.
REM
REM  Double-click this, or run it from a terminal. It pauses before each write so
REM  you can read what it is about to do and stop if the database host is wrong --
REM  the tool prints that host as its first line, deliberately.
REM
REM  To take the data out again:  seed-demo.bat remove
REM ---------------------------------------------------------------------------
cd /d "%~dp0server"

set "PROD_URL=postgresql://postgres.lksgcfmlnvkqneukoioa:SyedRaza%%40517@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"

if /i "%~1"=="remove" (
  set "MODE=--remove --apply"
  set "WHAT=REMOVE the DEMO data from"
) else (
  set "MODE=--apply"
  set "WHAT=ADD the DEMO data to"
)

echo.
echo ============================================================
echo  1 of 2  --  STAGING   (dry run first)
echo ============================================================
call node -r dotenv/config tools/seed-demo-timetable.js %MODE:--apply=%
echo.
echo About to %WHAT% STAGING. Check the database host above says eu-central-1.
pause
call node -r dotenv/config tools/seed-demo-timetable.js %MODE%

echo.
echo ============================================================
echo  2 of 2  --  PRODUCTION   (dry run first)
echo ============================================================
set "DATABASE_URL=%PROD_URL%"
call node tools/seed-demo-timetable.js %MODE:--apply=%
echo.
echo About to %WHAT% PRODUCTION. Check the database host above says eu-west-2.
echo This database holds your real college. Ctrl+C now to stop.
pause
call node tools/seed-demo-timetable.js %MODE%

echo.
echo Done. Everything written carries the "DEMO" prefix.
echo To undo:  seed-demo.bat remove
pause
