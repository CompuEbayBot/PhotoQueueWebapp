import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const API_URL = import.meta.env.VITE_APPS_SCRIPT_URL;

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = decodeURIComponent(
      atob(normalized)
        .split("")
        .map((c) => `%${("00" + c.charCodeAt(0).toString(16)).slice(-2)}`)
        .join(""),
    );
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

async function api(action, idToken, payload = {}) {
  if (!API_URL) throw new Error("Missing VITE_APPS_SCRIPT_URL");

  const response = await fetch(API_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, idToken, ...payload }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Backend returned a non-JSON response: ${text.slice(0, 180)}`,
    );
  }

  if (!data.ok) throw new Error(data.error || "Request failed");
  return data;
}

function App() {
  const [idToken, setIdToken] = useState(
    sessionStorage.getItem("photoQueueIdToken") || "",
  );
  const [user, setUser] = useState(() => {
    const token = sessionStorage.getItem("photoQueueIdToken");
    return token ? decodeJwtPayload(token) : null;
  });
  const [queue, setQueue] = useState([]);
  const [summary, setSummary] = useState({ total: 0, byCategory: {} });
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadingKey, setUploadingKey] = useState("");
  const [notice, setNotice] = useState("");
  const signInRef = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!window.google?.accounts?.id || !signInRef.current || idToken) return;
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: async ({ credential }) => {
          const payload = decodeJwtPayload(credential);
          setIdToken(credential);
          setUser(payload);
          sessionStorage.setItem("photoQueueIdToken", credential);
        },
      });
      window.google.accounts.id.renderButton(signInRef.current, {
        theme: "outline",
        size: "large",
        shape: "pill",
        text: "signin_with",
      });
      clearInterval(timer);
    }, 150);
    return () => clearInterval(timer);
  }, [idToken]);

  useEffect(() => {
    if (idToken) loadQueue();
  }, [idToken]);

  async function loadQueue() {
    setLoading(true);
    setError("");
    try {
      const data = await api("getQueue", idToken);
      setQueue(data.items || []);
      setSummary(data.summary || { total: 0, byCategory: {} });
    } catch (err) {
      setError(err.message);
      if (/token|auth|email|allow/i.test(err.message)) signOut();
    } finally {
      setLoading(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem("photoQueueIdToken");
    setIdToken("");
    setUser(null);
    setQueue([]);
    setSummary({ total: 0, byCategory: {} });
    setSelectedCategory("All");
    if (window.google?.accounts?.id)
      window.google.accounts.id.disableAutoSelect();
  }

  const categories = useMemo(
    () => ["All", ...Object.keys(summary.byCategory || {}).sort()],
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

  async function uploadPhotos(item, files) {
    const chosen = [...files];
    if (!chosen.length) return;

    const bad = chosen.find((f) => !f.type.startsWith("image/"));
    if (bad) return setError(`${bad.name} is not an image.`);

    const tooLarge = chosen.find((f) => f.size > 8 * 1024 * 1024);
    if (tooLarge)
      return setError(`${tooLarge.name} is over the 8 MB starter limit.`);

    setUploadingKey(item.rowKey);
    setError("");
    setNotice("");

    try {
      const images = await Promise.all(
        chosen.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () =>
                reject(new Error(`Could not read ${file.name}`));
              reader.onload = () => {
                const base64 = String(reader.result).split(",")[1];
                resolve({ name: file.name, mimeType: file.type, base64 });
              };
              reader.readAsDataURL(file);
            }),
        ),
      );

      const result = await api("uploadPhotos", idToken, {
        rowKey: item.rowKey,
        images,
      });

      setNotice(
        `Uploaded ${result.uploadedCount} photo(s) for ${item.customCode || item.model}.`,
      );
      await loadQueue();
    } catch (err) {
      setError(err.message);
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
          <div ref={signInRef} className="signin-slot" />
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
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="summary-grid">
        <div className="summary-card total">
          <span>Remaining</span>
          <strong>{summary.total ?? queue.length}</strong>
        </div>
        {Object.entries(summary.byCategory || {}).map(([category, count]) => (
          <button
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
        />
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
        >
          {categories.map((category) => (
            <option key={category}>{category}</option>
          ))}
        </select>
        <button className="secondary" onClick={loadQueue} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <section className="queue-card">
        <div className="queue-heading">
          <div>
            <h2>
              {selectedCategory === "All"
                ? "All pending photos"
                : selectedCategory}
            </h2>
            <p>
              {filtered.length} item{filtered.length === 1 ? "" : "s"} shown
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
              {filtered.map((item) => (
                <tr key={item.rowKey}>
                  <td>
                    <span className="pill">{item.category}</span>
                  </td>
                  <td className="mono strong">{item.model}</td>
                  <td>
                    <span
                      className={`grade grade-${String(item.grade).toLowerCase()}`}
                    >
                      {item.grade}
                    </span>
                  </td>
                  <td className="mono">{item.customCode}</td>
                  <td>
                    <label
                      className={`upload-button ${uploadingKey === item.rowKey ? "disabled" : ""}`}
                    >
                      {uploadingKey === item.rowKey
                        ? "Uploading…"
                        : "Choose photos"}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        disabled={uploadingKey === item.rowKey}
                        onChange={(e) => {
                          uploadPhotos(item, e.target.files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </td>
                </tr>
              ))}
              {!filtered.length && !loading && (
                <tr>
                  <td colSpan="5" className="empty">
                    Nothing pending in this view 🎉
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
