/**
 * Photo Queue Apps Script backend
 *
 * Script Properties required:
 *   SHEET_ID
 *   SHEET_NAME
 *   UPLOAD_FOLDER_ID
 *   GOOGLE_CLIENT_ID
 *   ALLOWED_EMAILS   comma-separated
 */

const HEADER_ROW = 3;   // Row containing repeated "Model / Grade / Photo Complete / Custom Code / Ghost?"
const CATEGORY_ROW = 1; // Row containing category names above each block
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function doGet() {
  return json_({
    ok: true,
    service: 'photo-queue',
    message: 'Use POST requests from the frontend.'
  });
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const user = authorize_(body.idToken);

    switch (body.action) {
      case 'getQueue':
        return json_(getQueue_(user));
      case 'uploadPhotos':
        return json_(uploadPhotos_(user, body));
      default:
        throw new Error('Unsupported action.');
    }
  } catch (err) {
    return json_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function authorize_(idToken) {
  if (!idToken) throw new Error('Missing Google ID token.');

  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw new Error('Server is missing GOOGLE_CLIENT_ID.');

  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error('Google sign-in token is invalid or expired.');

  const token = JSON.parse(response.getContentText());
  if (token.aud !== clientId) throw new Error('Google token audience mismatch.');
  if (!token.email || String(token.email_verified) !== 'true') throw new Error('Verified Google email required.');

  const allowed = (props.getProperty('ALLOWED_EMAILS') || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (!allowed.includes(token.email.toLowerCase())) {
    throw new Error('This Google account is not allowed to use Photo Queue.');
  }

  return { email: token.email, name: token.name || token.email };
}

function getQueue_(user) {
  const parsed = parseSheet_();
  const pending = parsed.items.filter((item) => item.photoComplete === false);

  const byCategory = {};
  pending.forEach((item) => {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  });

  return {
    ok: true,
    user,
    items: pending,
    summary: { total: pending.length, byCategory }
  };
}

function parseSheet_() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  const sheetName = props.getProperty('SHEET_NAME');
  if (!sheetId || !sheetName) throw new Error('Server is missing SHEET_ID or SHEET_NAME.');

  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(sheetName);
  if (!sheet) throw new Error('Configured sheet tab was not found.');

  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < HEADER_ROW) throw new Error('Sheet does not contain the configured header row.');

  const header = values[HEADER_ROW - 1];
  const categoryRow = values[CATEGORY_ROW - 1];
  const items = [];

  for (let col = 0; col < header.length; col++) {
    if (normalize_(header[col]) !== 'model') continue;

    const modelCol = col;
    const gradeCol = findFieldColumn_(header, modelCol, 'grade');
    const photoCol = findFieldColumn_(header, modelCol, 'photo complete');
    const customCol = findFieldColumn_(header, modelCol, 'custom code');
    const ghostCol = findFieldColumn_(header, modelCol, 'ghost?');

    if (gradeCol < 0 || photoCol < 0 || customCol < 0) continue;

    const category = findCategoryName_(categoryRow, modelCol) || `Category ${modelCol + 1}`;

    for (let row = HEADER_ROW; row < values.length; row++) {
      const model = String(values[row][modelCol] || '').trim();
      if (!model) continue;

      const grade = String(values[row][gradeCol] || '').trim();
      const photoComplete = parseBoolean_(values[row][photoCol]);
      const customCode = String(values[row][customCol] || '').trim();
      const ghost = ghostCol >= 0 ? String(values[row][ghostCol] || '').trim() : '';

      // If Photo Complete is blank, treat it as incomplete only when the row has a real model.
      items.push({
        category,
        model,
        grade,
        photoComplete,
        customCode,
        ghost,
        rowNumber: row + 1,
        modelColumn: modelCol + 1,
        photoColumn: photoCol + 1,
        rowKey: makeRowKey_(sheet.getSheetId(), row + 1, modelCol + 1, photoCol + 1, customCode || `${model}|${grade}`)
      });
    }
  }

  return { sheetId: sheet.getSheetId(), items };
}

function findFieldColumn_(header, startCol, fieldName) {
  // Category blocks in the supplied sheet are separated by blank columns.
  // Search only a small window so one block cannot accidentally consume the next block's fields.
  const max = Math.min(header.length, startCol + 6);
  for (let c = startCol; c < max; c++) {
    if (normalize_(header[c]) === fieldName) return c;
  }
  return -1;
}

function findCategoryName_(categoryRow, startCol) {
  // Titles are typically in the first column of each block.
  // Search left a couple of cells to tolerate merged headers / visual spacing.
  for (let c = startCol; c >= Math.max(0, startCol - 2); c--) {
    const text = String(categoryRow[c] || '').trim();
    if (text) return text.replace(/^\*\*|\*\*$/g, '').trim();
  }
  return '';
}

function parseBoolean_(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['true', 'yes', '1', 'y'].includes(v);
}

function normalize_(value) {
  return String(value || '').trim().toLowerCase();
}

function makeRowKey_(sheetGid, rowNumber, modelColumn, photoColumn, code) {
  const raw = [sheetGid, rowNumber, modelColumn, photoColumn, code].join('|');
  return Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function parseRowKey_(rowKey) {
  if (!rowKey) throw new Error('Missing row key.');
  let padded = rowKey;
  while (padded.length % 4) padded += '=';
  const raw = Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString();
  const parts = raw.split('|');
  if (parts.length < 5) throw new Error('Invalid row key.');
  return {
    sheetGid: Number(parts[0]),
    rowNumber: Number(parts[1]),
    modelColumn: Number(parts[2]),
    photoColumn: Number(parts[3]),
    code: parts.slice(4).join('|')
  };
}

function uploadPhotos_(user, body) {
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) throw new Error('No images supplied.');
  if (images.length > 12) throw new Error('Upload a maximum of 12 images at once.');

  const rowRef = parseRowKey_(body.rowKey);
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  const sheetName = props.getProperty('SHEET_NAME');
  const folderId = props.getProperty('UPLOAD_FOLDER_ID');
  if (!sheetId || !sheetName || !folderId) throw new Error('Server storage configuration is incomplete.');

  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(sheetName);
  if (!sheet || sheet.getSheetId() !== rowRef.sheetGid) throw new Error('Row key points to a different sheet.');

  // Re-validate the live row before writing anything.
  const model = String(sheet.getRange(rowRef.rowNumber, rowRef.modelColumn).getDisplayValue() || '').trim();
  const currentPhotoComplete = parseBoolean_(sheet.getRange(rowRef.rowNumber, rowRef.photoColumn).getDisplayValue());
  if (!model) throw new Error('The selected sheet row no longer contains a model.');
  if (currentPhotoComplete) throw new Error('This SKU is already marked complete. Refresh the queue.');

  const normalized = parseSheet_().items.find((item) => item.rowKey === body.rowKey);
  if (!normalized) throw new Error('This row is no longer part of the valid photo queue.');

  const folder = DriveApp.getFolderById(folderId);
  const baseName = sanitizeFilename_(normalized.customCode || `${normalized.model}_${normalized.grade}`);
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const createdIds = [];

  try {
    images.forEach((image, index) => {
      const mimeType = String(image.mimeType || '');
      if (!mimeType.startsWith('image/')) throw new Error('Only image uploads are allowed.');

      const bytes = Utilities.base64Decode(String(image.base64 || ''));
      if (!bytes.length) throw new Error('One uploaded image was empty.');
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('One uploaded image exceeded the 8 MB limit.');

      const extension = extensionForMime_(mimeType);
      const fileName = `${baseName}_${timestamp}_${String(index + 1).padStart(2, '0')}${extension}`;
      const blob = Utilities.newBlob(bytes, mimeType, fileName);
      const file = folder.createFile(blob);
      file.setDescription(`Photo Queue upload\nSKU: ${normalized.customCode || normalized.model}\nCategory: ${normalized.category}\nUploaded by: ${user.email}`);
      createdIds.push(file.getId());
    });

    // Mark complete only after every file is successfully created.
    sheet.getRange(rowRef.rowNumber, rowRef.photoColumn).setValue(true);
    SpreadsheetApp.flush();

    return {
      ok: true,
      uploadedCount: createdIds.length,
      item: {
        category: normalized.category,
        model: normalized.model,
        grade: normalized.grade,
        customCode: normalized.customCode
      }
    };
  } catch (err) {
    // Best-effort rollback for files created before an error.
    createdIds.forEach((id) => {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (_) {}
    });
    throw err;
  }
}

function extensionForMime_(mimeType) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/gif': '.gif'
  };
  return map[mimeType] || '.img';
}

function sanitizeFilename_(value) {
  return String(value || 'photo')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
