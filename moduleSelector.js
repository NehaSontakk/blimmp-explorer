// moduleSelector.js

import { renderGraph } from "./script.js";
console.log("renderGraph type:", typeof renderGraph);


// URLs for your fallback JSON data
export const nodesURL     = "https://raw.githubusercontent.com/NehaSontakk/Graph-Viz/refs/heads/main/all_module_nodes_Mar26-2.json";
export const adjacencyURL = "https://raw.githubusercontent.com/NehaSontakk/Graph-Viz/refs/heads/main/all_module_adjacency_links_Mar26-2.json";

// State holders
let uploadedNodesData = null;
//window.useDkAfter        = false;
window.currentModuleNodes = null;
window.currentModuleLinks = null;
window.currentBestPath    = null;
let threshold             = 0;

// Attempt to rehydrate from localStorage
try {
  const stored = localStorage.getItem('uploadedNodesData');
  if (stored) {
  uploadedNodesData = JSON.parse(stored);
  window.currentSampleJson = uploadedNodesData; 

}
} catch {}

try {
  const t = parseFloat(localStorage.getItem('moduleThreshold'));
  if (!isNaN(t)) threshold = t;
} catch {}



// Simple JSON fetcher
async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Error fetching ${url}: ${resp.statusText}`);
  return resp.json();
}

let moduleDataCache = null;
async function loadAllModules() {
  if (!moduleDataCache) {
    const [nodesData, adjData] = await Promise.all([fetchJSON(nodesURL), fetchJSON(adjacencyURL)]);
    moduleDataCache = { nodesData, adjData };
  }
  return moduleDataCache;
}

function getModuleNodesFromAll(allNodesData, moduleId) {
  const blk = allNodesData?.[moduleId];
  if (!blk) return null;

  // Shape A: { M00001: [ ...nodes... ] }
  if (Array.isArray(blk)) return blk;

  // Shape B: { M00001: { nodes: [ ... ] } }
  if (Array.isArray(blk.nodes)) return blk.nodes;

  return null;
}


// On DOM ready
window.addEventListener("DOMContentLoaded", () => {
  const uploadInput = document.getElementById("nodeJsonUpload");
  //const toggleChk   = document.getElementById("neighborToggle");
  const searchBtn   = document.getElementById("searchBtn");
  const threshInput = document.getElementById("thresholdInput");
  const moduleInput = document.getElementById("moduleInput");

  // Restore threshold input
  // Restore threshold input
  if (threshInput) threshInput.value = threshold;

  // If data was rehydrated from localStorage, reveal search immediately
  if (uploadedNodesData) {
    const row = document.getElementById("search-row");
    if (row) row.style.display = "flex";
    const overlayBtn = document.getElementById("modules-overlay-open");
    if (overlayBtn) overlayBtn.style.display = "block";
  }

function revealSearch() {
    const row = document.getElementById("search-row");
    if (row) row.style.display = "flex";
    const overlayBtn = document.getElementById("modules-overlay-open");
    if (overlayBtn) overlayBtn.style.display = "block";
  }

  // ── Module text search dropdown 
  const dropdown       = document.getElementById("module-dropdown");
  let   activeIndex    = -1;
  let   searchDebounce = null;
  let   flatModules    = null;


  // Load module metadata for text search
  const META_URL = "https://raw.githubusercontent.com/NehaSontakk/Graph-Viz/refs/heads/main/kegg_bacteria_modules.json";
  fetch(META_URL)
    .then(r => r.json())
    .then(data => {
      window.moduleMetaData = data;
      flatModules = null; // force rebuild on next search
    })
    .catch(err => console.warn("Failed to load module metadata:", err));

  function buildFlatModules() {
    const meta = window.moduleMetaData;
    if (!meta) return [];
    const out = [];
    for (const [cat, mods] of Object.entries(meta)) {
      for (const [id, info] of Object.entries(mods)) {
        out.push({ id, description: info.Description || "", category: cat });
      }
    }
    return out;
  }

  function escapeForHtml(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function highlight(text, query) {
    if (!query) return escapeForHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeForHtml(text);
    return escapeForHtml(text.slice(0, idx))
      + `<mark class="match-highlight">${escapeForHtml(text.slice(idx, idx + query.length))}</mark>`
      + escapeForHtml(text.slice(idx + query.length));
  }

  function hideDropdown() {
    if (dropdown) dropdown.style.display = "none";
    activeIndex = -1;
  }

  function selectModule(id) {
    moduleInput.value = id;
    hideDropdown();
    document.getElementById("searchBtn")?.click();
  }

  function showDropdown(query) {
    if (!dropdown) return;
    if (!flatModules || !flatModules.length) flatModules = buildFlatModules();
    if (!query || query.length < 2) { hideDropdown(); return; }

    const q = query.toLowerCase();
    const matches = flatModules
      .filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q)
      )
      .slice(0, 10);

    if (!matches.length) { hideDropdown(); return; }

    activeIndex = -1;
    dropdown.innerHTML = matches.map((m, i) => `
      <div class="module-dropdown-item" data-id="${m.id}" data-index="${i}">
        <span class="mid">${highlight(m.id, query)}</span>
        <span class="mdesc">${highlight(m.description, query)}</span>
        <div class="mcat">${escapeForHtml(m.category)}</div>
      </div>
    `).join("");

    dropdown.querySelectorAll(".module-dropdown-item").forEach(el => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectModule(el.getAttribute("data-id"));
      });
    });

    dropdown.style.display = "block";
  }

  moduleInput?.addEventListener("keydown", (e) => {
    const items = dropdown?.querySelectorAll(".module-dropdown-item") || [];
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      selectModule(items[activeIndex].getAttribute("data-id"));
      return;
    } else if (e.key === "Escape") {
      hideDropdown();
      return;
    }
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    if (activeIndex >= 0) items[activeIndex].scrollIntoView({ block: "nearest" });
  });

  moduleInput?.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => showDropdown(moduleInput.value.trim()), 150);
  });

  moduleInput?.addEventListener("focus", () => {
    if (moduleInput.value.trim().length >= 2) showDropdown(moduleInput.value.trim());
  });

  document.addEventListener("click", (e) => {
    if (!moduleInput?.contains(e.target) && !dropdown?.contains(e.target)) {
      hideDropdown();
    }
  });

  
document.getElementById("download-pdf-btn")?.addEventListener("click", async () => {
    const svgEl = document.querySelector("#graph-container svg");
    if (!svgEl) return alert("No graph to download yet.");

    const { jsPDF } = window.jspdf;

    const toDataUrl = (svgNode) => new Promise((resolve, reject) => {
      const str = new XMLSerializer().serializeToString(svgNode);
      const blob = new Blob([str], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });

    // --- dimensions ---
    const graphBB  = svgEl.getBoundingClientRect();
    const graphW   = svgEl.viewBox?.baseVal?.width  || graphBB.width;
    const graphH   = svgEl.viewBox?.baseVal?.height || graphBB.height;

    const legendSvgEl = document.querySelector("#legend-overlay svg");
    const legendBB    = legendSvgEl ? legendSvgEl.getBoundingClientRect() : null;
    const legendW     = legendBB ? legendBB.width  : 0;
    const legendH     = legendBB ? legendBB.height : 0;

    // --- confidence strings ---
    const rawMod    = window.currentModuleJson || {};
    const cleanId   = window.currentModuleId   || "";
    const modBlock  =
      ('module_probability_before' in rawMod || 'module_equation' in rawMod)
        ? rawMod
        : rawMod[cleanId] || null;

    const fmtP3 = (v) => (v == null || !isFinite(+v)) ? "—" : (+v).toPrecision(3);
    const confRaw   = fmtP3(modBlock?.module_probability_before);
    const confAfter = fmtP3(modBlock?.module_probability_after);
    const confLine1 = `Confidence (Raw): ${confRaw}`;
    const confLine2 = `Confidence (After Influencer Propagation): ${confAfter}`;

    // --- canvas layout ---
    const SCALE      = 2;
    const CONF_H     = 52;   // pixels reserved at top for confidence text
    const canvasW    = Math.max(graphW, graphW + legendW);
    const canvasH    = CONF_H + graphH;

    const canvas  = document.createElement("canvas");
    canvas.width  = canvasW * SCALE;
    canvas.height = canvasH * SCALE;
    const ctx     = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);

    // white background
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvasW, canvasH);

    // confidence text
    ctx.fillStyle = "#000";
    ctx.font      = "bold 15px Segoe UI, sans-serif";
    ctx.fillText(confLine1, 14, 20);
    ctx.font      = "14px Segoe UI, sans-serif";
    ctx.fillText(confLine2, 14, 40);

    // graph SVG
    try {
      const graphImg = await toDataUrl(svgEl);
      ctx.drawImage(graphImg, 0, CONF_H, graphW, graphH);
    } catch { /* skip if fails */ }

    // legend SVG (top-right corner, aligned with graph top)
    if (legendSvgEl) {
      try {
        const legendImg = await toDataUrl(legendSvgEl);
        ctx.drawImage(legendImg, graphW - legendW - 10, CONF_H + 10, legendW, legendH);
      } catch { }
    }

    const imgData = canvas.toDataURL("image/png");

    // title
    const titleEl = document.querySelector("#module-info span");
    const title   = titleEl ? titleEl.textContent.trim() : (cleanId || "Module");

    // PDF — scale canvas to fit A4 landscape
    const pdfW = 297, pdfH = 210;
    const pdf  = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

    pdf.setFontSize(13);
    pdf.setFont("helvetica", "bold");
    pdf.text(title, 10, 12, { maxWidth: pdfW - 20 });

    const margin = 6;
    const availW = pdfW - margin * 2;
    const availH = pdfH - 20 - margin;
    const aspect = canvasW / canvasH;
    let drawW = availW;
    let drawH = drawW / aspect;
    if (drawH > availH) { drawH = availH; drawW = drawH * aspect; }

    pdf.addImage(imgData, "PNG", margin, 20, drawW, drawH);
    pdf.save(`${cleanId || "graph"}.pdf`);
  });


  // Handle input file
  if (uploadInput) uploadInput.addEventListener("change", async (evt) => {
    const file = evt.target.files[0];
    if (!file) return;
    try {
      const rawText = await file.text();
      const sanitized = rawText.replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null");
      uploadedNodesData = JSON.parse(sanitized);
      window.currentSampleJson = uploadedNodesData;
      localStorage.setItem('uploadedNodesData', JSON.stringify(uploadedNodesData));
      revealSearch();
      if (typeof window.renderSections === "function") window.renderSections();
    } catch (err) {
      alert("Failed to parse uploaded JSON:\n" + err.message);
    }
  });


  // Apply threshold button (if exists)
  if (document.getElementById('applyBtn')) {
    document.getElementById('applyBtn').addEventListener('click', () => {
      const val = parseFloat(threshInput.value);
      threshold = isNaN(val) ? 0 : val;
      localStorage.setItem('moduleThreshold', threshold);
      if (typeof window.renderSections === "function") window.renderSections();
    });
  }

  // Main search
  if (searchBtn) searchBtn.addEventListener("click", async () => {
    console.log("Search clicked");
    const moduleId = moduleInput.value.trim();
    if (moduleId.length !== 6) return alert("Module ID must be 6 chars e.g. M00001");
    // persist threshold
    localStorage.setItem('moduleThreshold', threshold);
    // fetch modules
    const { nodesData: allNodesData, adjData: allAdjData } = await loadAllModules();

    // keep uploaded sample json around for overlay / module list / etc
    window.currentSampleJson = uploadedNodesData || allNodesData;

    // 1) moduleBlock: prefer uploaded (it has Dk/Dk_Neighbor etc)
    const moduleBlock =
      (uploadedNodesData?.[moduleId]) || (allNodesData?.[moduleId]);
    if (!moduleBlock) return alert(`Module ${moduleId} not found`);

    const moduleNodes = allNodesData?.[moduleId]?.nodes || allNodesData?.[moduleId];
    if (!Array.isArray(moduleNodes)) {
      console.log("Geometry shape file:", allNodesData?.[moduleId]);
      return alert(`Module ${moduleId} nodes not found in Oct 27 file`);
    }

    // Always take links from Oct 27
    const links = allAdjData?.[moduleId]?.links || allAdjData?.[moduleId];
    if (!Array.isArray(links)) {
      console.log("Adj shape debug:", allAdjData?.[moduleId]);
      return alert(`Links for ${moduleId} not found in Oct 27 file`);
    }

    // 4) If uploaded has per-node stats, merge them onto Oct27 nodes
    const overlayBlock = uploadedNodesData?.[moduleId] || null;

    // KEEP Oct27 geometry nodes in moduleNodes
    // Overlay values from uploaded nodes (suffix-agnostic)
    if (Array.isArray(uploadedNodesData)) {
      const overlayByBase = new Map(
        uploadedNodes
          .map(n => [KO_BASE(KO_ID(n["KO id"] ?? n.id)), n])
          .filter(([k]) => k)
      );

      const FIELDS = [
        "Dk","Dk_Neighbor","E-value","score","hit_conf",
        "flag_is_below_kofam_threshold","is_outcompeted",
        "kofam_score_threshold","buddy_stats","modules_present",
        "target name","overlapgroup_winner","overlapgroup_winner_score",
        "overlapgroup_winner_hit_conf","KO_freq","KO_Occurrence"
      ];

      moduleNodes.forEach(n => {
        const base = KO_BASE(KO_ID(n.id ?? n["KO id"]));
        const ov = overlayByBase.get(base);
        if (!ov) return;

        for (const k of FIELDS) {
          if (ov[k] !== undefined) n[k] = ov[k];
        }

        // optional: if Oct27 node lacks "KO id", populate it
        if (n["KO id"] == null && ov["KO id"] != null) n["KO id"] = ov["KO id"];
      });
    }

    // KEEP this
    moduleNodes.forEach(n => n["node-radius"] ??= 10);


    window.currentModuleId    = moduleId;
    window.currentModuleNodes = moduleNodes;
    window.currentModuleLinks = links;
    window.currentModuleBlock = moduleBlock;
    window.currentOverlayBlock = overlayBlock; 
    window.currentModuleJson  = moduleBlock;
    window.currentSampleJson   = uploadedNodesData || allNodesData;
    window.currentBestPath    = uploadedNodesData?.[moduleId]?.best_path || allNodesData[moduleId]?.best_path;
    console.log("About to call renderGraph", {
      moduleId: window.currentModuleId,
      nodesLen: window.currentModuleNodes?.length,
      linksLen: window.currentModuleLinks?.length,
      hasModuleBlock: !!window.currentModuleJson,
      bestPathType: typeof window.currentBestPath
    });
    console.log("Hi")
    console.log("CALL renderGraph nodes[0]:", moduleNodes?.[0]);
    console.log("CALL renderGraph links[0]:", links?.[0]);

     renderGraph(moduleNodes, links, window.currentBestPath, moduleId);
  });

  // Auto-search if URL has module param
  const params = new URLSearchParams(window.location.search);
  const m = params.get('module');
  if (m) {
    moduleInput.value = m;
    // trigger upload and threshold if stored, then click
    if (uploadedNodesData) if (typeof window.renderSections === "function") window.renderSections();
    searchBtn.click();
  }

  function sanitizeJsonText(rawText) {
  return rawText.replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null");
}

  //EXAMPLE UPLOAD
  const EXAMPLE_JSON_URL = "./Ver4__BLIMMP_modules.json"; 
  const exampleBtn = document.getElementById("load-example-btn");

  if (exampleBtn) exampleBtn.addEventListener("click", async () => {
    try {
      // optional status UI
      const statusEl = document.getElementById("load-example-status");
      if (statusEl) statusEl.textContent = "Loading example…";
      revealSearch();

      // Kick off nodes+adjacency fetch immediately, in parallel with example fetch
      const modulesPromise = loadAllModules();

      const res = await fetch(EXAMPLE_JSON_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const rawText = await res.text();
      const sanitized = sanitizeJsonText(rawText);
      uploadedNodesData = JSON.parse(sanitized);

      window.currentSampleJson = uploadedNodesData;
      localStorage.setItem("uploadedNodesData", JSON.stringify(uploadedNodesData));

      if (typeof window.renderSections === "function") window.renderSections();

      // Determine module ID
      const params = new URLSearchParams(window.location.search);
      const midFromUrl = params.get("module");

      let moduleId =
        (midFromUrl && uploadedNodesData?.[midFromUrl]) ? midFromUrl :
        (moduleInput?.value?.trim() && uploadedNodesData?.[moduleInput.value.trim()]) ? moduleInput.value.trim() :
        Object.keys(uploadedNodesData || {}).find(k => /^M\d{5}$/.test(k));

      if (!moduleId) {
        if (statusEl) statusEl.textContent = "Example loaded (no module found).";
        return alert("Example JSON loaded, but I couldn't find any Mxxxxx keys inside it.");
      }

      if (moduleInput) moduleInput.value = moduleId;

      // Wait for nodes+adjacency (likely already done by now), then render directly
      if (statusEl) statusEl.textContent = "Fetching graph data…";
      const { nodesData: allNodesData, adjData: allAdjData } = await modulesPromise;

      const moduleBlock = uploadedNodesData?.[moduleId] || allNodesData?.[moduleId];
      if (!moduleBlock) return alert(`Module ${moduleId} not found`);

      const moduleNodes = allNodesData?.[moduleId]?.nodes || allNodesData?.[moduleId];
      if (!Array.isArray(moduleNodes)) return alert(`Module ${moduleId} nodes not found`);

      const links = allAdjData?.[moduleId]?.links || allAdjData?.[moduleId];
      if (!Array.isArray(links)) return alert(`Links for ${moduleId} not found`);

      const overlayBlock = uploadedNodesData?.[moduleId] || null;
      moduleNodes.forEach(n => n["node-radius"] ??= 10);

      window.currentModuleId       = moduleId;
      window.currentModuleNodes    = moduleNodes;
      window.currentModuleLinks    = links;
      window.currentModuleBlock    = moduleBlock;
      window.currentOverlayBlock   = overlayBlock;
      window.currentModuleJson     = moduleBlock;
      window.currentSampleJson     = uploadedNodesData || allNodesData;
      window.currentBestPath       = uploadedNodesData?.[moduleId]?.best_path || allNodesData[moduleId]?.best_path;


      
      renderGraph(moduleNodes, links, window.currentBestPath, moduleId);

      if (typeof window.openModulesOverlayWhenReady === "function") {
        window.openModulesOverlayWhenReady({ retries: 60, delayMs: 75 });
      } else {
        console.warn("openModulesOverlayWhenReady not on window");
      }

      if (statusEl) statusEl.textContent = `Example loaded: ${moduleId}`;
    } catch (err) {
      console.error("Example load failed:", err);
      const statusEl = document.getElementById("load-example-status");
      if (statusEl) statusEl.textContent = "Failed to load example.";
      alert("Failed to load example JSON (see console).");
    }
  });




});

// Optional: expose threshold to renderSections in module.html
window.getModuleThreshold = () => threshold;


