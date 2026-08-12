import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
const API_URL = String(import.meta.env.VITE_APPS_SCRIPT_URL || "").trim();

const TOKEN_STORAGE_KEY = "photoQueueIdToken";
const MAX_FILES_PER_UPLOAD = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 24 * 1024 * 1024;
const API_TIMEOUT_MS = 45_000;

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = decodeURIComponent(
      atob(padded)
        .split("")
        .map((c) => `%${("00" + c.charCodeAt(0).toString(16)).slice(-2)}`)
        .join(""),
    );

    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isTokenExpired(token) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  return Date.now() >= Number(payload.exp) * 1000 - 30_000;
}

function readStoredSession() {
  const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
  if (!token || isTokenExpired(token)) {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    return { token: "", user: null };
  }

  return { token, user: decodeJwtPayload(token) };
}

function friendlyApiError(message) {
  const text = String(message || "Request failed");

  if (/not allowed|unauthor/i.test(text)) {
    return "This Google account is not authorized to use Photo Queue.";
  }
  if (/token.*expired|token.*invalid|missing google id token/i.test(text)) {
    return "Your sign-in session expired. Please sign in again.";
  }
  if (/audience mismatch/i.test(text)) {
    return "Google sign-in is misconfigured. The frontend and backend OAuth Client IDs do not match.";
  }

  return text;
}

async function api(action, idToken, payload = {}, { signal } = {}) {
  if (!API_URL) throw new Error("Missing VITE_APPS_SCRIPT_URL");
  if (!idToken) throw new Error("Missing Google ID token.");

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), API_TIMEOUT_MS);

  const abortFromCaller = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify({ action, idToken, ...payload }),
      signal: timeoutController.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Backend request failed with HTTP ${response.status}.`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (/<!doctype html|<html/i.test(text)) {
        throw new Error(
          "The Apps Script endpoint returned an HTML page instead of JSON. Verify that VITE_APPS_SCRIPT_URL points to the current /exec deployment and that the web app is accessible.",
        );
      }
      throw new Error("Backend returned an invalid response.");
    }

    if (!data?.ok) {
      throw new Error(data?.error || "Backend request failed.");
    }

    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("The request timed out. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      if (comma < 0) return reject(new Error(`Could not encode ${file.name}.`));

      resolve({
        name: file.name,
        mimeType: file.type,
        base64: result.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

function App() {
  const initialSession = useMemo(() => readStoredSession(), []);

  const [idToken, setIdToken] = useState(initialSession.token);
  const [user, setUser] = useState(initialSession.user);
  const [queue, setQueue] = useState([]);
  const [summary, setSummary] = useState({ total: 0, byCategory: {} });
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authError, setAuthError] = useState("");
  const [uploadingKey, setUploadingKey] = useState("");
  const [notice, setNotice] = useState("");

  const signInRef = useRef(null);
  const googleInitializedRef = useRef(false);
  const queueRequestRef = useRef(null);

  function clearSession(message = "") {
    queueRequestRef.current?.abort();
    queueRequestRef.current = null;

    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    setIdToken("");
    setUser(null);
    setQueue([]);
    setSummary({ total: 0, byCategory: {} });
    setSelectedCategory("All");
    setUploadingKey("");
    setError("");
    setNotice("");
    setAuthError(message);

    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
  }

  function signOut() {
    clearSession("");
  }

  useEffect(() => {
    if (idToken && isTokenExpired(idToken)) {
      clearSession("Your sign-in session expired. Please sign in again.");
    }
  }, [idToken]);

  useEffect(() => {
    if (idToken || !CLIENT_ID) return undefined;

    let cancelled = false;
    let attempts = 0;

    const initializeGoogle = () => {
      if (cancelled || idToken) return;

      if (!window.google?.accounts?.id) {
        attempts += 1;
        if (attempts < 80) window.setTimeout(initializeGoogle, 125);
        else
          setAuthError(
            "Google Sign-In could not be loaded. Refresh the page and try again.",
          );
        return;
      }

      if (!googleInitializedRef.current) {
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: ({ credential }) => {
            if (!credential) {
              setAuthError("Google did not return a sign-in credential.");
              return;
            }

            const payload = decodeJwtPayload(credential);
            if (!payload?.email || isTokenExpired(credential)) {
              setAuthError("Google returned an invalid sign-in credential.");
              return;
            }

            sessionStorage.setItem(TOKEN_STORAGE_KEY, credential);
            setAuthError("");
            setError("");
            setNotice("");
            setUser(payload);
            setIdToken(credential);
          },
        });
        googleInitializedRef.current = true;
      }

      if (signInRef.current) {
        signInRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(signInRef.current, {
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "signin_with",
          width: 280,
        });
      }
    };

    initializeGoogle();
    return () => {
      cancelled = true;
    };
  }, [idToken]);

  async function loadQueue(token = idToken) {
    if (!token) return;

    queueRequestRef.current?.abort();
    const controller = new AbortController();
    queueRequestRef.current = controller;

    setLoading(true);
    setError("");

    try {
      const data = await api(
        "getQueue",
        token,
        {},
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;

      const items = Array.isArray(data.items) ? data.items : [];
      const nextSummary =
        data.summary && typeof data.summary === "object"
          ? data.summary
          : { total: items.length, byCategory: {} };

      setQueue(items);
      setSummary(nextSummary);

      if (data.user) {
        setUser((current) => ({ ...current, ...data.user }));
      }
    } catch (err) {
      if (controller.signal.aborted) return;

      const message = friendlyApiError(err.message);
      if (/not authorized|session expired|token|sign-in/i.test(message)) {
        clearSession(message);
      } else {
        setError(message);
      }
    } finally {
      if (queueRequestRef.current === controller) {
        queueRequestRef.current = null;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    if (idToken) loadQueue(idToken);
    return () => queueRequestRef.current?.abort();
  }, [idToken]);

  const categories = useMemo(
    () => [
      "All",
      ...Object.keys(summary.byCategory || {}).sort((a, b) =>
        a.localeCompare(b),
      ),
    ],
    [summary],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return queue.filter((item) => {
      if (selectedCategory !== "All" && item.category !== selectedCategory)
        return false;
      if (!q) return true;

      return [item.model, item.grade, item.customCode, item.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [queue, selectedCategory, search]);

  async function uploadPhotos(item, fileList) {
    const chosen = Array.from(fileList || []);
    if (!chosen.length || uploadingKey) return;

    if (chosen.length > MAX_FILES_PER_UPLOAD) {
      setError(`Choose no more than ${MAX_FILES_PER_UPLOAD} photos at once.`);
      return;
    }

    const invalid = chosen.find((file) => !file.type?.startsWith("image/"));
    if (invalid) {
      setError(`${invalid.name} is not a supported image file.`);
      return;
    }

    const tooLarge = chosen.find((file) => file.size > MAX_IMAGE_BYTES);
    if (tooLarge) {
      setError(`${tooLarge.name} is larger than 8 MB.`);
      return;
    }

    const totalBytes = chosen.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) {
      setError(
        "This batch is too large. Keep the selected photos under 24 MB total and try again.",
      );
      return;
    }

    setUploadingKey(item.rowKey);
    setError("");
    setNotice("");

    try {
      const images = await Promise.all(chosen.map(fileToBase64));
      const result = await api("uploadPhotos", idToken, {
        rowKey: item.rowKey,
        images,
      });

      setNotice(
        `Uploaded ${result.uploadedCount} photo${result.uploadedCount === 1 ? "" : "s"} for ${item.customCode || item.model}.`,
      );

      // Optimistically remove the completed SKU so the interface responds immediately.
      setQueue((current) =>
        current.filter((row) => row.rowKey !== item.rowKey),
      );
      setSummary((current) => {
        const byCategory = { ...(current.byCategory || {}) };
        const category = item.category;

        if (category && Number(byCategory[category]) > 0) {
          byCategory[category] = Number(byCategory[category]) - 1;
          if (byCategory[category] <= 0) delete byCategory[category];
        }

        return {
          total: Math.max(0, Number(current.total || 0) - 1),
          byCategory,
        };
      });

      // Reconcile with the live backend after the optimistic update.
      await loadQueue(idToken);
    } catch (err) {
      const message = friendlyApiError(err.message);
      if (/not authorized|session expired|token|sign-in/i.test(message)) {
        clearSession(message);
      } else {
        setError(message);
      }
    } finally {
      setUploadingKey("");
    }
  }

  if (!idToken) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">PQ</div>
          <h1>Photo Queue</h1>
          <p>
            Sign in with an approved Google account to view and upload product
            photos.
          </p>

          {!CLIENT_ID && (
            <div className="alert error">Missing VITE_GOOGLE_CLIENT_ID</div>
          )}
          {!API_URL && (
            <div className="alert error">Missing VITE_APPS_SCRIPT_URL</div>
          )}
          {authError && <div className="alert error">{authError}</div>}

          {CLIENT_ID && API_URL && (
            <div ref={signInRef} className="signin-slot" />
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PHOTO OPERATIONS</p>
          <h1>Photo Queue</h1>
        </div>

        <div className="account">
          <div>
            <strong>{user?.name || user?.email || "Signed in"}</strong>
            <span>{user?.email}</span>
          </div>
          <button className="secondary" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="summary-grid">
        <button
          type="button"
          className={`summary-card total ${selectedCategory === "All" ? "active" : ""}`}
          onClick={() => setSelectedCategory("All")}
        >
          <span>Remaining</span>
          <strong>{summary.total ?? queue.length}</strong>
        </button>

        {Object.entries(summary.byCategory || {}).map(([category, count]) => (
          <button
            type="button"
            className={`summary-card ${selectedCategory === category ? "active" : ""}`}
            key={category}
            onClick={() => setSelectedCategory(category)}
          >
            <span>{category}</span>
            <strong>{count}</strong>
          </button>
        ))}
      </section>

      <section className="toolbar">
        <input
          type="search"
          placeholder="Search model, grade, custom code..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />

        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
        >
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>

        <button
          className="secondary"
          type="button"
          onClick={() => loadQueue(idToken)}
          disabled={loading || Boolean(uploadingKey)}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <section
        className="queue-card"
        aria-busy={loading || Boolean(uploadingKey)}
      >
        <div className="queue-heading">
          <div>
            <h2>
              {selectedCategory === "All"
                ? "All pending photos"
                : selectedCategory}
            </h2>
            <p>
              {filtered.length} item{filtered.length === 1 ? "" : "s"} shown
              {uploadingKey ? " · Upload in progress" : ""}
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Model</th>
                <th>Grade</th>
                <th>Custom code</th>
                <th>Upload</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((item) => {
                const isUploading = uploadingKey === item.rowKey;

                return (
                  <tr key={item.rowKey}>
                    <td>
                      <span className="pill">{item.category}</span>
                    </td>
                    <td className="mono strong">{item.model}</td>
                    <td>
                      <span
                        className={`grade grade-${String(item.grade || "").toLowerCase()}`}
                      >
                        {item.grade || "—"}
                      </span>
                    </td>
                    <td className="mono">{item.customCode || "—"}</td>
                    <td>
                      <label
                        className={`upload-button ${isUploading ? "disabled" : ""}`}
                      >
                        {isUploading ? "Uploading…" : "Choose photos"}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif"
                          multiple
                          disabled={Boolean(uploadingKey)}
                          onChange={(e) => {
                            const files = e.target.files;
                            e.target.value = "";
                            uploadPhotos(item, files);
                          }}
                        />
                      </label>
                    </td>
                  </tr>
                );
              })}

              {!filtered.length && !loading && (
                <tr>
                  <td colSpan="5" className="empty">
                    Nothing pending in this view 🎉
                  </td>
                </tr>
              )}

              {loading && !filtered.length && (
                <tr>
                  <td colSpan="5" className="empty">
                    Loading photo queue…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
