/*============================================================
   StoreMaster Worker V8.1 FINAL
   GitHub + Cloudflare Pages + KV + Secure Admin Session

   IMPORTANT:
   - GITHUB_TOKEN stays ONLY in Worker env.
   - Admin password = last 10 characters of storeId.
   - STORE_ID is stored in Cloudflare KV, never injected into adm.html.
   - Public Cloudflare URL comes from the Pages project subdomain,
     never from a random deployment URL.
   ============================================================ */

const APP_VERSION = "8.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Master-Key"
};

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { "Content-Type": "application/json;charset=UTF-8", ...CORS }
});

const success = (data = {}, status = 200) => json({ success: true, ...data }, status);
const error = (message, status = 400, details = null) => json({ success: false, error: message, details }, status);

function normalizeRepo(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSite(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:///, "")
    .replace(//.*$/, "")
    .replace(/^/+|/+$/g, "");
}

const licenseKey = id => license:${id};
const siteKey = site => site:${normalizeSite(site)};
const sessionKey = token => session:${token};

function getMasterKey(request) {
  return request.headers.get("X-Master-Key") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
}

function requireMaster(request, env) {
  return Boolean(env.MASTER_API_KEY) && getMasterKey(request) === env.MASTER_API_KEY;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value))
  );
  return [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function isExpired(date) {
  if (!date) return false;
  const d = new Date(${date}T23:59:59.999Z);
  return Number.isFinite(d.getTime()) && new Date() > d;
}

function validateLicenseObject(license) {
  if (!license) return "Boutique introuvable";
  if (license.status !== "active") return "Licence inactive";
  if (isExpired(license.expirationDate)) return "Licence expirée";
  return null;
}

async function saveLicense(env, license) {
  await env.LICENSES.put(licenseKey(license.storeId), JSON.stringify(license));
}

async function getLicense(env, storeId) {
  if (!storeId) return null;
  const raw = await env.LICENSES.get(licenseKey(storeId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function getLicenseBySite(env, site) {
  const normalized = normalizeSite(site);
  if (!normalized) return null;

  const mappedStoreId = await env.LICENSES.get(siteKey(normalized));
  if (mappedStoreId) {
    const direct = await getLicense(env, mappedStoreId);
    if (direct) return direct;
  }

  /* Compatibility/fallback for older KV layouts. */
  let cursor;
  do {
    const page = await env.LICENSES.list({ prefix: "license:", cursor });
    for (const key of page.keys || []) {
      const id = key.name.slice("license:".length);
      const license = await getLicense(env, id);
      if (!license) continue;

      const candidates = [
        license.siteKey,
        license.cloudflare?.url,
        license.cloudflare?.subdomain,
        license.cloudflareUrl,
        license.siteUrl,
        license.domain
      ].map(normalizeSite).filter(Boolean);

      if (candidates.includes(normalized)) {
        await env.LICENSES.put(siteKey(normalized), license.storeId);
        return license;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return null;
}

/* ---------------- GitHub ---------------- */

async function githubRaw(env, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": Bearer ${env.GITHUB\_TOKEN},
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "StoreMaster-Worker-V8.1",
      ...(options.headers || {})
    }
  });

  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type") || "application/json"
  };
}

async function github(env, url, options = {}) {
  const result = await githubRaw(env, url, options);
  let data;
  try { data = result.body ? JSON.parse(result.body) : null; } catch { data = result.body; }
  if (!result.ok) {
    throw new Error(GitHub API ${result.status}: ${data?.message || result.body || "Erreur GitHub"});
  }
  return data;
}

async function getGitHubOwner(env) {
  return github(env, "https://api.github.com/user");
}

async function createRepository(env, name, description) {
  return github(env, "https://api.github.com/user/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description,
      private: false,
      auto_init: true,
      has_issues: false,
      has_projects: false,
      has_wiki: false
    })
  });
}

async function getTree(env, owner, repo) {
  for (const branch of ["main", "master"]) {
    try {
      const data = await github(
        env,
        https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${branch}?recursive=1
      );
      return { branch, tree: data.tree || [] };
    } catch (_) {}
  }
  throw new Error("Branche du template introuvable");
}

function githubRepoUrl(owner, repo) {
  return https://api.github.com/repos/${encodeURIComponent(String(owner || ""))}/${encodeURIComponent(String(repo || ""))};
}

async function getGitHubDefaultBranch(env, owner, repo) {
  const url = githubRepoUrl(owner, repo);
  try {
    const data = await github(env, url);
    return String(data?.default_branch || "main").trim() || "main";
  } catch (e) {
    const message = e?.message || String(e);
    throw new Error(${message} | owner=${owner} | repository=${repo} | url=${url});
  }
}

async function getGitHubFile(env, owner, repo, path, ref = "main") {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return github(
    env,
    https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(ref)}
  );
}

function decodeGitHubBase64(content) {
  const raw = atob(String(content || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(content) {
  const bytes = new TextEncoder().encode(String(content));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function putGitHubFile(env, owner, repo, path, content, message, branch = null) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const targetBranch = String(branch || await getGitHubDefaultBranch(env, owner, repo)).trim() || "main";
  let sha = undefined;

  try {
    const existing = await getGitHubFile(env, owner, repo, path, targetBranch);
    sha = existing?.sha;
  } catch (_) {}

  const body = {
    message,
    content: encodeBase64Utf8(content),
    branch: targetBranch
  };
  if (sha) body.sha = sha;

  return github(
    env,
    https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded},
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
}

const TEMPLATES = {
  template1: { id: "template1", name: "dawn-dz", repository: "dawn-dz" },
  template2: { id: "template2", name: "ShopLive", repository: "shoplive" },
  template3: { id: "template3", name: "hassoun", repository: "hassoun" }
};

async function copyTemplate(env, sourceRepo, targetRepo, store) {
  const owner = env.GITHUB_OWNER;
  const source = await getTree(env, owner, sourceRepo);
  const files = source.tree.filter(x => x.type === "blob");
  let copied = 0;

  for (const item of files) {
    const file = await getGitHubFile(env, owner, sourceRepo, item.path, source.branch);
    let content;

    if (file?.content) {
      content = decodeGitHubBase64(file.content);
    } else {
      throw new Error(Impossible de lire le fichier template: ${item.path});
    }

    if (item.path === "adm.html") {
      content = content.replaceAll("{{LICENSE_SERVER}}", store.workerUrl);
    }

    if (item.path === "config/store-config.json") {
      try {
        const cfg = JSON.parse(content);
        cfg.LICENSE_SERVER = store.workerUrl;
        cfg.STORE_INFO = cfg.STORE_INFO || {};
        cfg.STORE_INFO.name = store.storeName;
        delete cfg.STORE_ID;
        delete cfg.STORE_TOKEN;
        delete cfg.STORE_TOKEN_HINT;
        content = JSON.stringify(cfg, null, 2);
      } catch {
        content = content.replaceAll("{{LICENSE_SERVER}}", store.workerUrl);
      }
    }

    if (item.path === "config.js") {
      content = content
        .replaceAll("{{LICENSE_SERVER}}", store.workerUrl)
        .replaceAll("{{STORE_ID}}", "")
        .replaceAll("{{TOKEN_HINT}}", "");
    }

    await putGitHubFile(
      env,
      owner,
      targetRepo,
      item.path,
      content,
      StoreMaster V8.1: copie ${item.path}
    );
    copied++;
  }

  return copied;
}

/* ---------------- Deployment Trigger ---------------- */

async function triggerGitHubDeployment(env, repo) {
  const owner = env.GITHUB_OWNER;
  const path = ".storemaster-deploy.json";
  const content = JSON.stringify({
    storemaster: true,
    version: APP_VERSION,
    timestamp: new Date().toISOString()
  }, null, 2);

  await putGitHubFile(
    env,
    owner,
    repo,
    path,
    content,
    "StoreMaster: déclenchement du déploiement Cloudflare Pages"
  );
}

/* ---------------- Cloudflare Pages ---------------- */

function cloudflareRequired(env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("Variable CLOUDFLARE_ACCOUNT_ID manquante");
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("Secret CLOUDFLARE_API_TOKEN manquant");
}

async function cloudflare(env, path, options = {}) {
  cloudflareRequired(env);
  const response = await fetch(https://api.cloudflare.com/client/v4${path}, {
    ...options,
    headers: {
      "Authorization": Bearer ${env.CLOUDFLARE\_API\_TOKEN},
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok || data?.success === false) {
    const messages = Array.isArray(data?.errors)
      ? data.errors.map(x => x.message).join(" | ")
      : "";
    throw new Error(Cloudflare API ${response.status}: ${messages || data?.message || text || "Erreur Cloudflare"});
  }

  return data;
}

async function getCloudflareProject(env, projectName) {
  return cloudflare(
    env,
    /accounts/${encodeURIComponent(env.CLOUDFLARE\_ACCOUNT\_ID)}/pages/projects/${encodeURIComponent(projectName)}
  );
}

async function getCloudflareProjectOrNull(env, projectName) {
  try {
    return (await getCloudflareProject(env, projectName)).result || null;
  } catch (e) {
    if (String(e.message).includes("Cloudflare API 404")) return null;
    throw e;
  }
}

async function createCloudflareProject(env, repo, projectName) {
  const owner = repo.owner?.login || env.GITHUB_OWNER;
  const ownerId = repo.owner?.id != null ? String(repo.owner.id) : undefined;

  const config = {
    owner,
    repo_name: repo.name,
    repo_id: String(repo.id),
    production_branch: "main",
    production_deployments_enabled: true,
    preview_deployment_setting: "none",
    pr_comments_enabled: false
  };
  if (ownerId) config.owner_id = ownerId;

  const payload = {
    name: projectName,
    production_branch: "main",
    build_config: {
      build_command: "",
      destination_dir: "/",
      root_dir: "/"
    },
    source: {
      type: "github",
      config
    }
  };

  const data = await cloudflare(
    env,
    /accounts/${encodeURIComponent(env.CLOUDFLARE\_ACCOUNT\_ID)}/pages/projects,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );

  return data.result;
}

function stableProjectUrl(project, projectName) {
  const candidates = [
    project?.subdomain,
    project?.canonical_deployment?.aliases?.find(x => String(x).endsWith(".pages.dev")),
    project?.latest_deployment?.aliases?.find(x => String(x).endsWith(".pages.dev"))
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate).trim().replace(//+$/, "");
    if (!value) continue;
    return value.startsWith("http") ? value : https://${value};
  }

  /* Last-resort deterministic fallback, never a random deployment URL. */
  return projectName ? https://${projectName}.[pages.dev](http://pages.dev/) : null;
}

function cloudflareInfo(project) {
  const latest = project?.latest_deployment || null;
  const canonical = project?.canonical_deployment || null;
  const stableUrl = stableProjectUrl(project, project?.name);

  return {
    projectName: project?.name || null,
    projectId: project?.id || null,
    subdomain: project?.subdomain || null,
    url: stableUrl,
    productionBranch: project?.production_branch || project?.source?.config?.production_branch || "main",
    deploymentStatus: latest?.latest_stage?.status || null,
    deploymentId: latest?.id || null,
    deploymentUrl: latest?.url || null,
    canonicalAliases: canonical?.aliases || [],
    gitConnected: project?.source?.type === "github"
  };
}

async function refreshLicenseFromProject(env, license, project) {
  const info = cloudflareInfo(project);
  license.cloudflare = {
    ...(license.cloudflare || {}),
    ...info,
    status: "connected",
    lastError: null,
    checkedAt: new Date().toISOString()
  };

  if (info.url) {
    const normalized = normalizeSite(info.url);
    license.siteKey = normalized;
    await env.LICENSES.put(siteKey(normalized), license.storeId);
  }

  const deploymentStatus = String(info.deploymentStatus || "").toLowerCase();
  const deployed = ["success", "complete", "completed", "active"].includes(deploymentStatus);

  if (deployed) {
    license.status = "active";
    license.siteUrl = info.url;
  } else if (license.status === "creating" || license.status === "active") {
    license.status = "pending";
  }

  license.updatedAt = new Date().toISOString();
  await saveLicense(env, license);
  return info;
}

/* ---------------- Sessions / Admin ---------------- */

async function createSession(env, license) {
  const token = ${crypto.randomUUID()}-${crypto.getRandomValues(new Uint8Array(16)).join("")};
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;

  await env.LICENSES.put(
    sessionKey(token),
    JSON.stringify({ storeId: license.storeId, expiresAt }),
    { expirationTtl: 8 * 60 * 60 }
  );

  return { token, expiresAt };
}

async function getSession(env, token) {
  if (!token) return null;
  const raw = await env.LICENSES.get(sessionKey(token));
  if (!raw) return null;

  try {
    const session = JSON.parse(raw);
    if (!session || Date.now() > session.expiresAt) return null;
    return session;
  } catch {
    return null;
  }
}

async function login(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Données de connexion invalides", 400); }

  const site = normalizeSite(body.siteKey);
  const password = String(body.password || "").trim();

  if (!site || password.length !== 10) {
    return error("Données de connexion invalides", 400);
  }

  const license = await getLicenseBySite(env, site);
  const invalid = validateLicenseObject(license);
  if (invalid) return error(invalid, 401);

  const passwordHash = await sha256(password);
  if (!license.tokenHash || passwordHash !== license.tokenHash) {
    return error("كلمة المرور غير صحيحة", 401);
  }

  const session = await createSession(env, license);

  return success({
    session: session.token,
    expiresAt: new Date(session.expiresAt).toISOString(),
    storeName: license.storeName || "",
    clientName: license.client || "",
    repository: license.repository || "",
    githubOwner: env.GITHUB_OWNER || "",
    store: {
      storeId: license.storeId,
      repository: license.repository || ""
    },
    cloudflare: license.cloudflare || null
  });
}

async function authenticateSession(env, token) {
  const session = await getSession(env, token);
  if (!session) return { ok: false, error: "Session expirée. Connectez-vous à nouveau." };

  const license = await getLicense(env, session.storeId);
  const invalid = validateLicenseObject(license);
  if (invalid) return { ok: false, error: invalid };

  return { ok: true, session, license };
}

/* ---------------- Secure GitHub proxy ---------------- */

async function githubProxy(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête invalide", 400); }

  const auth = await authenticateSession(env, body.session);
  if (!auth.ok) return error(auth.error, 401);

  let target;
  try { target = new URL(String(body.url || "")); }
  catch { return error("URL GitHub invalide", 400); }

  if (target.origin !== "https://api.github.com") {
    return error("Destination GitHub refusée", 403);
  }

  const prefix = /repos/${encodeURIComponent(env.GITHUB\_OWNER)}/${encodeURIComponent(auth.license.repository)};
  if (!(target.pathname === prefix || target.pathname.startsWith(prefix + "/"))) {
    return error("Accès refusé à un autre repository", 403);
  }

  const method = String(body.method || "GET").toUpperCase();
  const headers = { ...(body.headers || {}) };
  delete headers.Authorization;
  delete headers.authorization;
  delete headers.Host;
  delete headers.host;

  const result = await githubRaw(env, target.toString(), {
    method,
    headers,
    body: ["GET", "HEAD"].includes(method) ? undefined : (body.body ?? undefined)
  });

  auth.license.lastSync = new Date().toISOString();
  auth.license.updatedAt = auth.license.lastSync;
  await saveLicense(env, auth.license);

  return success({
    status: result.status,
    body: result.body,
    headers: { "Content-Type": result.contentType }
  }, result.ok ? 200 : result.status);
}

/* ---------------- Admin session check ---------------- */

async function adminSessionCheck(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête invalide", 400); }

  const token = String(body?.session || "").trim();
  if (!token) return error("Session manquante", 401);

  const auth = await authenticateSession(env, token);
  if (!auth.ok) return error(auth.error, 401);

  return success({
    authenticated: true,
    repository: auth.license.repository || "",
    githubOwner: env.GITHUB_OWNER || "",
    expiresAt: auth.session?.expiresAt || null
  });
}

/* ---------------- Admin GitHub diagnostic ---------------- */

async function adminGitHubCheck(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête invalide", 400); }

  const auth = await authenticateSession(env, body.session);
  if (!auth.ok) return error(auth.error, 401);

  const owner = String(env.GITHUB_OWNER || "").trim();
  const repo = String(auth.license.repository || "").trim();
  const url = githubRepoUrl(owner, repo);

  if (!owner || !repo) {
    return error("Informations GitHub incomplètes", 500, {
      step: "validate-repository", owner, repository: repo, url
    });
  }

  try {
    const data = await github(env, url);
    return success({
      accessible: true,
      owner,
      repository: repo,
      url,
      defaultBranch: String(data?.default_branch || "main").trim() || "main",
      private: data?.private ?? null
    });
  } catch (e) {
    return error("Repository GitHub غير متاح", 502, {
      step: "github-repository-check",
      owner,
      repository: repo,
      url,
      message: e?.message || String(e)
    });
  }
}

/* ---------------- Admin config endpoint ---------------- */

async function getAdminConfig(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête invalide", 400); }

  const auth = await authenticateSession(env, body.session);
  if (!auth.ok) return error(auth.error, 401);

  const owner = env.GITHUB_OWNER;
  const repo = auth.license.repository;
  const branch = await getGitHubDefaultBranch(env, owner, repo);
  const file = await getGitHubFile(env, owner, repo, "config/store-config.json", branch);

  if (!file?.content) return error("Fichier config/store-config.json introuvable", 404);

  let config;
  try {
    config = JSON.parse(decodeGitHubBase64(file.content));
  } catch {
    return error("Le fichier config/store-config.json est invalide", 500);
  }

  auth.license.lastSync = new Date().toISOString();
  auth.license.updatedAt = auth.license.lastSync;
  await saveLicense(env, auth.license);

  return success({
    config,
    repository: repo,
    githubOwner: owner,
    path: "config/store-config.json",
    branch
  });
}

/* ---------------- Admin config save ---------------- */

async function saveAdminConfig(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête invalide", 400); }

  const auth = await authenticateSession(env, body.session);
  if (!auth.ok) return error(auth.error, 401);

  /* Lightweight probe: lets the browser verify the exact save route before
     sending the complete configuration payload. */
  if (body.probe === true) {
    return success({ saveEndpoint: true, authenticated: true });
  }

  if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
    return error("Configuration invalide", 400);
  }

  const owner = env.GITHUB_OWNER;
  const repo = auth.license.repository;
  let branch;
  try {
    branch = await getGitHubDefaultBranch(env, owner, repo);
  } catch (e) {
    return error("Impossible de déterminer la branche GitHub", 502, {
      step: "get-default-branch",
      owner,
      repository: repo,
      url: githubRepoUrl(owner, repo),
      message: e?.message || String(e)
    });
  }
  const jsonContent = JSON.stringify(body.config, null, 2);
  const configJsContent = `// =============================================================================
// ⚙️ ملف الإعدادات الرئيسي للمتجر
// =============================================================================

const STORE_CONFIG = ${JSON.stringify(body.config, null, 2)};

// =============================================================================
// 🛍️ دالة تحميل المنتجات
// =============================================================================

function loadProductsConfig() {
    return STORE_CONFIG.PRODUCTS;
}

// =============================================================================
// 🚚 دالة تحميل أسعار التوصيل
// =============================================================================

function loadDeliveryConfig() {
    return {
        deliveryPrices: STORE_CONFIG.DELIVERY_PRICES || {},
        freeDelivery: STORE_CONFIG.FREE_DELIVERY || {},
        freeDeliveryProducts: STORE_CONFIG.FREE_DELIVERY.freeDeliveryProducts || []
    };
}

// =============================================================================
// 💰 دالة تحميل إعدادات الخصم
// =============================================================================

function loadDiscountConfig() {
    return STORE_CONFIG.DISCOUNTS || {};
}

// =============================================================================
// 🏪 دالة تحميل معلومات المتجر
// =============================================================================

function loadStoreInfo() {
    return STORE_CONFIG.STORE_INFO || {};
}

// =============================================================================
// 🎨 دالة تحميل الألوان والمقاسات
// =============================================================================

function loadSizesColorsConfig() {
    return {
        availableColors: STORE_CONFIG.AVAILABLE_COLORS || [],
        availableSizes: STORE_CONFIG.AVAILABLE_SIZES || [],
        sizeGuide: STORE_CONFIG.SIZE_GUIDE || {}
    };
}

// =============================================================================
// 📊 دالة تحميل إعدادات البكسل
// =============================================================================

function loadPixelConfig() {
    return STORE_CONFIG.PIXEL_CODES || {};
}

// =============================================================================
// 📊 دالة تحميل جميع الإعدادات
// =============================================================================

function loadAllConfig() {
    return STORE_CONFIG;
}

// =============================================================================
// 🔄 دالة تحديث الإعدادات
// =============================================================================

function updateConfig(newConfig) {
    for (const key in newConfig) {
        if (newConfig.hasOwnProperty(key)) {
            STORE_CONFIG[key] = newConfig[key];
        }
    }
    return STORE_CONFIG;
}
;     const message = String(body.message || Mise à jour des configurations - ${new Date().toISOString()}`).slice(0, 200);

  try {
    const jsonResult = await putGitHubFile(env, owner, repo, "config/store-config.json", jsonContent, message, branch);
    const jsResult = await putGitHubFile(env, owner, repo, "config.js", configJsContent, message, branch);
    auth.license.lastSync = new Date().toISOString();
    auth.license.updatedAt = auth.license.lastSync;
    await saveLicense(env, auth.license);

    return success({
      saved: true,
      repository: repo,
      githubOwner: owner,
      branch,
      files: {
        storeConfig: { path: "config/store-config.json", sha: jsonResult?.content?.sha || null },
        configJs: { path: "config.js", sha: jsResult?.content?.sha || null }
      },
      commit: jsResult?.commit?.sha || jsonResult?.commit?.sha || null
    });
  } catch (e) {
    return error("Échec de la synchronisation GitHub", 502, {
      step: "put-github-file",
      owner,
      repository: repo,
      url: githubRepoUrl(owner, repo),
      message: e?.message || String(e),
      branch,
      paths: ["config/store-config.json", "config.js"]
    });
  }
}

/* ---------------- Store creation ---------------- */

async function createStore(request, env) {
  if (!requireMaster(request, env)) return error("MASTER_API_KEY invalide", 401);
  if (!env.LICENSES) return error("KV binding LICENSES manquant", 500);

  cloudflareRequired(env);

  let body;
  try { body = await request.json(); } catch { return error("JSON invalide", 400); }

  const client = String(body.client || "").trim();
  const storeName = String(body.storeName || body.nomBoutique || "").trim().replace(/\s+/g, " ");
  const repository = normalizeRepo(body.repository || body.repositoryName);
  const templateId = String(body.template || body.templateId || "").trim();
  const expirationDate = body.expirationDate || body.dateExpiration || null;

  if (!storeName) return error("Nom boutique obligatoire");
  if (!repository) return error("Nom repository obligatoire");

  const template = TEMPLATES[templateId];
  if (!template) return error("Template introuvable");

  const projectName = normalizeRepo(body.pagesProjectName || repository);
  const requestedSite = normalizeSite(body.siteKey || ${projectName}.[pages.dev](http://pages.dev/));

  if (await env.LICENSES.get(siteKey(requestedSite))) {
    return error("Ce site est déjà utilisé", 409);
  }

  const storeId = crypto.randomUUID();
  const adminPassword = storeId.slice(-10);
  const now = new Date().toISOString();
  const workerUrl = new URL(request.url).origin;

  const license = {
    version: 8.1,
    storeId,
    client,
    storeName,
    repository,
    siteKey: requestedSite,
    template: template.id,
    expirationDate,
    status: "creating",
    tokenHash: await sha256(adminPassword),
    createdAt: now,
    updatedAt: now,
    lastVerification: null,
    lastSync: null,
    cloudflare: {
      projectName,
      projectId: null,
      status: "pending",
      createdAt: null,
      url: null,
      subdomain: null,
      productionBranch: "main",
      deploymentStatus: null,
      deploymentId: null,
      deploymentUrl: null,
      gitConnected: false,
      lastError: null
    }
  };

  await saveLicense(env, license);
  await env.LICENSES.put(siteKey(requestedSite), storeId);

  let repo = null;
  let copiedFiles = 0;
  let project = null;

  try {
    repo = await createRepository(env, repository, StoreMaster V8.1 - ${storeName});

    copiedFiles = await copyTemplate(
      env,
      template.repository,
      repository,
      { storeName, workerUrl }
    );

    project = await getCloudflareProjectOrNull(env, projectName);
    if (!project) {
      project = await createCloudflareProject(env, repo, projectName);
    }

    const info = await refreshLicenseFromProject(env, license, project);

    /* Trigger GitHub -> Cloudflare Pages deployment without exposing storeId. */
    await triggerGitHubDeployment(env, repository);

    license.cloudflare.lastError = null;
    license.cloudflare.status = "deployment_pending";
    license.cloudflare.url = info.url;
    license.cloudflare.subdomain = info.subdomain;
    license.updatedAt = new Date().toISOString();
    await saveLicense(env, license);

    /* Give Cloudflare a short window to start the deployment. */
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const refreshed = await getCloudflareProjectOrNull(env, projectName);
      if (!refreshed) continue;
      project = refreshed;
      const latestInfo = await refreshLicenseFromProject(env, license, project);

      const status = String(latestInfo.deploymentStatus || "").toLowerCase();
      if (["success", "complete", "completed", "active"].includes(status)) {
        license.status = "active";
        license.cloudflare.status = "connected";
        license.siteUrl = latestInfo.url;
        license.updatedAt = new Date().toISOString();
        await saveLicense(env, license);

        return success({
          message: "Boutique créée et déployée sur Cloudflare Pages avec succès",
          process: {
            status: "completed",
            steps: [
              "Licence créée dans Cloudflare KV",
              "Repository GitHub créé",
              Template ${template.name} copié,
              ${copiedFiles} fichier(s) traité(s),
              "Projet Cloudflare Pages créé",
              "Déploiement Cloudflare Pages terminé"
            ]
          },
          store: {
            client,
            name: storeName,
            repository,
            siteKey: license.siteKey,
            template: template.name
          },
          identifiers: { adminPassword },
          license: {
            status: license.status,
            expirationDate: license.expirationDate,
            storeId
          },
          github: {
            repository,
            repositoryId: repo.id || null,
            repositoryUrl: repo.html_url || https://github.com/${env.GITHUB\_OWNER}/${repository},
            branch: "main"
          },
          cloudflare: {
            status: license.cloudflare.status,
            projectName: license.cloudflare.projectName,
            projectId: license.cloudflare.projectId,
            productionBranch: license.cloudflare.productionBranch,
            url: license.cloudflare.url,
            subdomain: license.cloudflare.subdomain,
            deploymentStatus: license.cloudflare.deploymentStatus,
            deploymentId: license.cloudflare.deploymentId,
            deploymentUrl: license.cloudflare.deploymentUrl || null
          },
          copiedFiles,
          repositoryUrl: repo.html_url || https://github.com/${env.GITHUB\_OWNER}/${repository}
        });
      }
    }

    /* Deployment can take longer than the Worker wait window.
       Keep the license pending; status endpoint can finalize it later. */
    license.status = "pending";
    license.cloudflare.status = "deployment_pending";
    license.updatedAt = new Date().toISOString();
    await saveLicense(env, license);

    return success({
      message: "Boutique créée. Déploiement Cloudflare Pages en cours.",
      process: {
        status: "pending_deployment",
        steps: [
          "Licence créée dans Cloudflare KV",
          "Repository GitHub créé",
          Template ${template.name} copié,
          ${copiedFiles} fichier(s) traité(s),
          "Projet Cloudflare Pages créé",
          "Déploiement Cloudflare Pages en cours"
        ]
      },
      store: {
        client,
        name: storeName,
        repository,
        siteKey: license.siteKey,
        template: template.name
      },
      identifiers: { adminPassword },
      license: {
        status: license.status,
        expirationDate: license.expirationDate,
        storeId
      },
      github: {
        repository,
        repositoryId: repo.id || null,
        repositoryUrl: repo.html_url || https://github.com/${env.GITHUB\_OWNER}/${repository},
        branch: "main"
      },
      cloudflare: {
        status: license.cloudflare.status,
        projectName: license.cloudflare.projectName,
        projectId: license.cloudflare.projectId,
        productionBranch: license.cloudflare.productionBranch,
        url: license.cloudflare.url,
        subdomain: license.cloudflare.subdomain,
        deploymentStatus: license.cloudflare.deploymentStatus,
        deploymentId: license.cloudflare.deploymentId,
        deploymentUrl: license.cloudflare.deploymentUrl || null
      },
      copiedFiles,
      repositoryUrl: repo.html_url || https://github.com/${env.GITHUB\_OWNER}/${repository}
    });

  } catch (e) {
    license.status = "deployment_error";
    license.cloudflare.status = "error";
    license.cloudflare.lastError = e?.message || String(e);
    license.updatedAt = new Date().toISOString();
    await saveLicense(env, license);

    return error("Création de la boutique incomplète", 500, {
      message: e?.message || String(e),
      github: {
        repositoryCreated: Boolean(repo),
        repository,
        copiedFiles
      },
      cloudflare: {
        projectName,
        status: license.cloudflare.status,
        error: license.cloudflare.lastError
      }
    });
  }
}

/* ---------------- Orders bridge ---------------- */

function ordersConfig(env) {
  const url = String(env.ORDERS_SCRIPT_URL || "").trim();
  const secret = String(env.ORDERS_API_SECRET || "").trim();
  if (!url) throw new Error("Variable ORDERS_SCRIPT_URL manquante");
  if (!secret) throw new Error("Secret ORDERS_API_SECRET manquant");
  return { url, secret };
}

async function callOrdersScript(env, payload) {
  const cfg = ordersConfig(env);
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8"
    },
    body: JSON.stringify({ ...payload, secret: cfg.secret })
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || Google Apps Script HTTP ${response.status});
  }
  return data;
}

function requestSiteFromHeaders(request) {
  const origin = String(request.headers.get("Origin") || "").trim();
  const referer = String(request.headers.get("Referer") || "").trim();
  for (const candidate of [origin, referer]) {
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      const host = normalizeSite(u.hostname);
      if (host) return host;
    } catch (_) {}
  }
  return "";
}

async function createPublicOrder(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Commande invalide", 400); }
  const site = requestSiteFromHeaders(request);
  if (!site) return error("Boutique introuvable", 400);

  const license = await getLicenseBySite(env, site);
  const invalid = validateLicenseObject(license);
  if (invalid) return error(invalid, 403);

  const order = body.order || body.data || {};
  const result = await callOrdersScript(env, {
    action: "createOrder",
    storeKey: license.siteKey || site,
    storeId: license.storeId,
    storeName: license.storeName || "",
    data: order
  });

  return success(result);
}

async function adminOrders(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête invalide", 400); }
  const auth = await authenticateSession(env, body.session);
  if (!auth.ok) return error(auth.error, 401);

  const requestedAction = String(body.action || "list").trim();
  const actionMap = { getOrder: "get", updateOrderStatus: "updateStatus" };
  const action = actionMap[requestedAction] || requestedAction;
  const storeKey = auth.license.siteKey;
  if (!storeKey) return error("Clé boutique introuvable", 500);

  const safePayload = {
    action,
    storeKey,
    storeId: auth.license.storeId,
    filters: body.filters || {},
    page: Math.max(1, Number(body.page) || 1),
    pageSize: Math.min(100, Math.max(10, Number(body.pageSize) || 50)),
    orderId: body.orderId || "",
    status: body.status || "",
    note: body.note || ""
  };

  const result = await callOrdersScript(env, safePayload);
  return success(result);
}

/* ---------------- Checkout Analytics bridge ---------------- */

const CHECKOUT_EVENTS = new Set([
  "store_home_view",
  "product_view",
  "begin_checkout",
  "wilaya_selected",
  "delivery_selected",
  "details_started",
  "checkout_submit_attempt",
  "purchase",
  "checkout_abandoned"
]);

async function checkoutEvents(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête Analytics invalide", 400); }
  const site = requestSiteFromHeaders(request);
  if (!site) return error("Boutique introuvable", 400);
  const license = await getLicenseBySite(env, site);
  const invalid = validateLicenseObject(license);
  if (invalid) return error(invalid, 403);
  const event = String(body.event || "").trim();
  const sessionId = String(body.sessionId || "").trim();
  if (!CHECKOUT_EVENTS.has(event)) return error("Événement Checkout invalide", 400);
  if (!sessionId) return error("Session Checkout obligatoire", 400);
  // نحافظ على بيانات المنتجات المرتبطة بالجلسة حتى تظهر أيضًا في Checkout غير المكتمل.
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems.slice(0,30).map((it) => ({
    name: String(it?.name || it?.productName || it?.title || "منتج").slice(0,160),
    quantity: Math.max(1, Math.min(999, Number(it?.quantity) || 1)),
    price: Number(it?.price) || 0,
    finalPrice: Number(it?.finalPrice ?? it?.price) || 0,
    size: String(it?.size || "").slice(0,50),
    color: String(it?.color || "").slice(0,80),
    productId: String(it?.productId || it?.id || "").slice(0,100)
  }));
  const safe = {
    event,
    sessionId: sessionId.slice(0,120),
    timestamp: String(body.timestamp || new Date().toISOString()).slice(0,80),
    path: String(body.path || "").slice(0,300),
    stage: Number(body.stage || 0),
    wilaya: String(body.wilaya || "").slice(0,200),
    deliveryType: String(body.deliveryType || "").slice(0,50),
    field: String(body.field || "").slice(0,50),
    cartCount: Number(body.cartCount || 0),
    cartValue: Number(body.cartValue || 0),
    total: Number(body.total || 0),
    items
  };
  const result = await callOrdersScript(env, {
    action: "recordCheckoutEvent",
    storeKey: license.siteKey || site,
    storeId: license.storeId,
    storeName: license.storeName || "",
    data: safe
  });
  return success(result);
}

async function adminCheckoutAnalytics(request, env) {
  let body;
  try { body = await request.json(); } catch { return error("Requête Analytics invalide", 400); }
  const auth = await authenticateSession(env, body.session);
  if (!auth.ok) return error(auth.error, 401);
  const result = await callOrdersScript(env, {
    action: "checkoutAnalytics",
    storeKey: auth.license.siteKey,
    storeId: auth.license.storeId,
    filters: body.filters || {}
  });
  return success(result);
}

/* ---------------- Cloudflare status ---------------- */

async function cloudflareStatus(request, env) {
  if (!requireMaster(request, env)) return error("MASTER_API_KEY invalide", 401);

  let projectName = "";
  if (request.method === "GET") {
    const url = new URL(request.url);
    projectName = normalizeRepo(url.searchParams.get("project") || url.searchParams.get("projectName") || url.searchParams.get("repository"));
  } else {
    let body = {};
    try { body = await request.json(); } catch (_) {}
    projectName = normalizeRepo(body.project || body.projectName || body.repository);
  }

  if (!projectName) return error("Nom du projet Cloudflare obligatoire");

  const project = await getCloudflareProject(env, projectName);
  const info = cloudflareInfo(project.result);

  /* If this project belongs to a StoreMaster license, refresh its status. */
  let matchedLicense = null;
  let cursor;
  do {
    const page = await env.LICENSES.list({ prefix: "license:", cursor });
    for (const key of page.keys || []) {
      const id = key.name.slice("license:".length);
      const license = await getLicense(env, id);
      if (!license) continue;
      if (license.repository === projectName || license.cloudflare?.projectName === projectName) {
        matchedLicense = license;
        await refreshLicenseFromProject(env, matchedLicense, project.result);
        break;
      }
    }
    cursor = matchedLicense ? undefined : (page.list_complete ? undefined : page.cursor);
  } while (cursor);

  return success({
    exists: true,
    project: info.projectName || projectName,
    url: info.url,
    subdomain: info.subdomain,
    status: info.deploymentStatus || "not_deployed",
    deploymentStatus: info.deploymentStatus || "not_deployed",
    deploymentId: info.deploymentId,
    deploymentUrl: info.deploymentUrl,
    productionBranch: info.productionBranch,
    gitConnected: info.gitConnected,
    licenseStatus: matchedLicense?.status || null,
    rawStatus: info.deploymentStatus || null
  });
}

/* ---------------- Health ---------------- */

function health(env) {
  return {
    service: "StoreMaster Worker",
    version: APP_VERSION,
    status: "online",
    timestamp: new Date().toISOString(),
    integrations: {
      github: Boolean(env.GITHUB_OWNER && env.GITHUB_TOKEN),
      cloudflarePages: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
      licensesKV: Boolean(env.LICENSES)
    }
  };
}

/* ---------------- Router ---------------- */

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === "GET" && (path === "/" || path === "/health")) {
        return success(health(env));
      }

      if (!env.LICENSES) return error("KV binding LICENSES manquant", 500);
      if (!env.GITHUB_OWNER) return error("Variable GITHUB_OWNER manquante", 500);
      if (!env.GITHUB_TOKEN) return error("Secret GITHUB_TOKEN manquant", 500);

      if (method === "POST" && path === "/api/admin/login") {
        return login(request, env);
      }

      if (method === "POST" && path === "/api/admin/session-check") {
        return adminSessionCheck(request, env);
      }

      if (method === "POST" && path === "/api/admin/github-check") {
        return adminGitHubCheck(request, env);
      }

      if (method === "POST" && path === "/api/admin/config") {
        return getAdminConfig(request, env);
      }

      if (method === "POST" && path === "/api/admin/config/save") {
        return saveAdminConfig(request, env);
      }

      if (method === "POST" && path === "/api/orders") {
        return createPublicOrder(request, env);
      }

      if (method === "POST" && path === "/api/checkout/events") {
        return checkoutEvents(request, env);
      }

      if (method === "POST" && path === "/api/admin/checkout-analytics") {
        return adminCheckoutAnalytics(request, env);
      }

      if (method === "POST" && path === "/api/admin/orders") {
        return adminOrders(request, env);
      }

      if (method === "POST" && path === "/api/github/proxy") {
        return githubProxy(request, env);
      }

      if (method === "POST" && path === "/api/store/create") {
        return createStore(request, env);
      }

      if ((method === "GET" || method === "POST") && path === "/api/cloudflare/status") {
        return cloudflareStatus(request, env);
      }

      return error("Route introuvable", 404, { method, path });
    } catch (e) {
      return error("Erreur interne du Worker", 500, e?.message || String(e));
    }
  }
};
