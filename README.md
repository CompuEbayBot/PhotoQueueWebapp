# Photo Queue Webapp

Lightweight internal photo workflow for a Google Sheet + Google Drive backend.

## Architecture

- **Frontend:** React + Vite, deployable to GitHub Pages.
- **Authentication:** Google Identity Services (Google Sign-In).
- **Backend:** Google Apps Script Web App, executed as the script owner.
- **Data:** Existing Google Sheet with horizontal category blocks.
- **Uploads:** Sent only through the Apps Script endpoint into one configured Drive folder.

The employee does **not** need direct access to your Drive folder. The Apps Script runs as you and exposes only a small allow-listed API.

## What v1 does

1. User signs in with Google.
2. Backend verifies the Google ID token and checks the email allow-list.
3. Frontend loads all rows where `Photo Complete = FALSE`.
4. User filters/searches the queue.
5. User picks a SKU and uploads one or more images.
6. Backend writes images to the configured Drive folder.
7. Backend flips that exact sheet row's `Photo Complete` cell to `TRUE` after successful upload.

## Sheet layout expected

Your current sheet has multiple product-category blocks arranged horizontally. Each block begins with a category title, then a header row containing fields like:

- Model
- Grade
- Photo Complete
- Custom Code
- Ghost? (some categories)

The parser in `apps-script/Code.gs` scans the header row for repeated `Model` columns, detects the category title above each block, and normalizes everything into one queue.

## Security model

- No Drive OAuth scope is granted to the employee.
- No generic file browser, delete, move, or rename API exists.
- The Apps Script checks the Google ID token on **every** request.
- The Apps Script checks the user's email against `ALLOWED_EMAILS` on **every** request.
- Sheet ID, destination folder ID, and OAuth client ID live in Apps Script **Script Properties**, not in GitHub.
- Uploads are append-only.
- Completion can only update the `Photo Complete` cell for a row returned by the parser.

> Important: deploy the Apps Script Web App as **Execute as: Me** and **Who has access: Anyone**. The endpoint itself then enforces Google login and your allow-list. This is necessary for a GitHub Pages frontend to call it without giving the employee your Drive permissions.

## 1. Set up Google OAuth

Create a Web OAuth Client in Google Cloud Console / Google Auth Platform.

Add these Authorized JavaScript origins:

- `http://localhost:5173`
- `https://YOUR_GITHUB_USERNAME.github.io`

Copy the Client ID.

## 2. Configure Apps Script

Create a standalone Apps Script project at script.google.com and copy these files into it:

- `apps-script/Code.gs`
- `apps-script/appsscript.json`

In **Project Settings → Script Properties**, create:

- `SHEET_ID` = your Google Sheet ID
- `SHEET_NAME` = worksheet/tab name, e.g. `Sheet1`
- `UPLOAD_FOLDER_ID` = destination Google Drive folder ID
- `GOOGLE_CLIENT_ID` = OAuth Web Client ID
- `ALLOWED_EMAILS` = comma-separated emails, e.g. `you@company.com,photographer@company.com`

Then deploy:

- Deploy → New deployment → Web app
- Execute as: **Me**
- Who has access: **Anyone**

Copy the `/exec` URL.

## 3. Configure frontend

```bash
cd frontend
cp .env.example .env
```

Edit `.env`:

```env
VITE_GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
VITE_APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
```

## 4. Run locally

```bash
npm install
npm run dev
```

## 5. Deploy to GitHub Pages

Update `vite.config.js` if this app is hosted at a project path like:

`https://username.github.io/photo-queue/`

Then:

```bash
npm run build
```

Deploy the `dist/` directory with GitHub Actions or your preferred Pages workflow.

## Notes / limitations

Apps Script is intentionally lightweight. It is great for a small internal photo team but is not an unlimited file-ingestion service. The frontend caps individual image files at 8 MB in this starter. If you later need large RAW files, hundreds of simultaneous uploads, or resumable uploads, move only the backend to Cloud Run / Firebase while keeping the same frontend.

The parser assumes the category title is two rows above the first data row and the field names are on one shared header row. If your live Sheet has extra title/header rows, adjust `HEADER_ROW` and `CATEGORY_ROW` in `Code.gs`.
