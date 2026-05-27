# TSF Exporter Staff Guide

## What to give to staff

Do not send source code folders from the main app.

Send only the final exporter bundle as one folder or one zip:

- `TSF Exporter.exe`
- `vendor/`
- `config/`
- `README_staff.pdf`

Inside `vendor/`, keep:

- `vendor/tally-loader/`
- `vendor/node/` if the private loader needs its own Node runtime

Best practice:

- Zip the full `dist/TSF Exporter/` folder after Windows packaging.
- Staff should receive that full folder unchanged.

Do not give staff these main-app folders:

- `components/`
- `services/`
- `desktop-backend/`
- `dist/` from the main app
- `node_modules/`

## How staff should use it

1. Extract the zip to a normal folder on the computer.
2. Open Tally and keep the correct company open.
3. Double-click `TSF Exporter.exe`.
4. Enter `From Date` and `To Date` in `dd/mm/yyyy` format.
5. Choose the output folder if needed.
6. Click `Run Export`.
7. Wait for the success message.
8. Collect the generated file:
   - `Tally_Source_File_yyyy-mm-dd.tsf`

## Important rules

- Staff should not open the `vendor` folder.
- Staff should not run the loader separately.
- Keep the full bundle together in one folder.
- If the bundle is moved, move the whole folder, not just the `.exe`.

## If something fails

- Check that Tally is open.
- Check that the correct company is open in Tally.
- Check that the staff member can write to the selected output folder.
- Check the log file created by the exporter.

## Recommended delivery method

Give staff one zip containing the packaged exporter folder only.

Example:

- `TSF_Exporter_Staff_Pack.zip`

Inside that zip:

- `TSF Exporter.exe`
- `vendor/`
- `config/`
- `README_staff.pdf`
