// Globals to track current data and toggle state
//window.useDkAfter = false;
let currentNodes = [];
let currentLinks = [];

// SVG layout constants
const MAX_SVG_W = 1750;
const BASE_SVG_H = 1200;
const PAD_T = 5, PAD_R = 250, PAD_B = 20, PAD_L = 300;
const TOP_OFFSET = 10;


//Added Sep 4
window.nodeByBase = new Map();
window.koIndex = new Map();   // KO_BASE -> node object from uploaded JSON


// Use new "KO id" when present, else fallback to old .id
// Prefer "KO id" first, fallback to old .id
const NODE_ID = (n) => n?.["KO id"] ?? n?.id;


const KO_ID = (id) => id == null ? id : String(id).replace(/^ko:/i,"").trim();
const KO_BASE = (id) => id == null ? id : String(id).split("_")[0];
const KO_FULL_ID = (nOrId) => KO_ID(typeof nOrId === "object" ? NODE_ID(nOrId) : nOrId);


const fmtP3 = (v) => (v == null || !isFinite(+v)) ? "—" : (+v).toPrecision(3);

const keggKoLink = (ko) =>`https://www.kegg.jp/dbget-bin/www_bget?ko:${ko}`;

const keggRxnLink = (rxn) =>`https://www.kegg.jp/dbget-bin/www_bget?rn:${rxn}`;




// Load BLIMMP module JSON globally (contains "steps" per module)
const MODULE_DATA_URL = "./KEGG_Module_Equations_Jan26.json";

window.moduleData = {};

(async function loadModuleData() {
  try {
    const res = await fetch(MODULE_DATA_URL);
    const json = await res.json();
    window.moduleData = json;
    console.log(
      `Loaded moduleData (${Object.keys(json).length} modules) from GitHub`
    );
  } catch (err) {
    console.error("Failed to load BLIMMP_modules.json:", err);
    window.moduleData = {};
  }
})();

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function linkifyKOsToKegg(text) {
  // Convert K00001 -> <a ...>K00001</a>
  // Works inside arbitrary text (equations, lists, etc.)
  const safe = escapeHtml(text);
  return safe.replace(/\bK\d{5}\b/g, (ko) => {
    return `<a class="ko-link" href="${keggKoLink(ko)}"
              target="_blank" rel="noopener noreferrer">${ko}</a>`;
  });
}

// Tooltip setup
const tooltip = d3.select('body')
  .append('div')
  .attr('class', 'tooltip')
  .style('position', 'absolute')
  .style('background', 'rgba(255,255,255,0.9)')
  .style('padding', '5px')
  .style('border', '1px solid #ccc')
  .style('border-radius', '4px')
  .style('pointer-events', 'none')
  .style('opacity', 0);

  let tooltipHideTimer = null;

tooltip
  .style('pointer-events', 'auto')     // allow mouse to interact with tooltip
  .on('mouseenter', () => {
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = null;
    tooltip.interrupt();              // stop any fade-out in progress
    tooltip.style('opacity', 0.98);
  })
  .on('mouseleave', () => {
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(() => {
      tooltip.transition().duration(120).style('opacity', 0);
    }, 40); 
  });


// Metadata for modules
const metaURL = 'https://raw.githubusercontent.com/NehaSontakk/Graph-Viz/refs/heads/main/kegg_bacteria_modules.json';
let moduleMetaData = null;
let moduleToCategory = new Map();

fetch(metaURL)
  .then(r => r.json())
  .then(data => {
    moduleMetaData = data;
    moduleToCategory = buildModuleToCategoryMap(data);
  })
  .catch(() => {
    moduleMetaData = {};
    moduleToCategory = new Map();
  });

let _tooltipExpandHandlerInstalled = false;

function installTooltipExpandHandlerOnce() {
  if (_tooltipExpandHandlerInstalled) return;
  _tooltipExpandHandlerInstalled = true;

  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest(".tooltip-expand-btn");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const ko = btn.getAttribute("data-ko");
    if (!ko) return;

    const arr = (window.nodeByBase && window.nodeByBase.get(ko)) || null;
    const datum = (arr && arr.length) ? arr[0] : ko;

    renderInfluencePanelForSink(datum);
  });
}

function moveTooltipToEvent(evt, offsetX = 10, offsetY = 12) {
  const legendEl = document.getElementById("legend-overlay");
  const ttW = tooltip.node().offsetWidth || 280;
  const ttH = tooltip.node().offsetHeight || 200;

  let left = evt.pageX + offsetX;
  let top  = evt.pageY - offsetY;

  // If the legend overlay is visible, keep tooltip from overlapping it
  if (legendEl) {
    const lr = legendEl.getBoundingClientRect();
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;

    const legendLeft  = lr.left  + scrollX;
    const legendRight = lr.right + scrollX;
    const legendTop   = lr.top   + scrollY;

    // Legend is on the right side — if tooltip would overlap it, push left
    const wouldOverlapX = (left + ttW) > legendLeft && left < legendRight;
    const wouldOverlapY = (top + ttH) > legendTop;

    if (wouldOverlapX && wouldOverlapY) {
      left = legendLeft - ttW - 16;
    }
  }

  // Also keep tooltip within the viewport horizontally
  const vpW = window.innerWidth;
  if (left + ttW > vpW - 10) left = evt.pageX - ttW - offsetX;
  if (left < 8) left = 8;

  tooltip
    .style("left", left + "px")
    .style("top",  top  + "px");
}

function getModuleInfo(mid) {
  const id = String(mid || "").trim();
  if (!moduleMetaData || typeof moduleMetaData !== "object") return null;

  // moduleMetaData is shaped like { CategoryName: { M00001: {...}, ... }, ... }
  for (const cat in moduleMetaData) {
    const hit = moduleMetaData?.[cat]?.[id];
    if (hit) return { category: cat, ...hit };
  }
  return null;
}

function trunc25(s) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > 25 ? (t.slice(0, 25) + "…") : t;
}

function displayModuleInfo(moduleId) {
  const container = d3.select('#module-info').html('');
  if (moduleMetaData === null) {
    container.text('Loading module metadata...');
    return;
  }

  const cleanId = String(moduleId).trim();

  const modBlock = window.currentModuleBlock || null;

  const confAfter = (modBlock && Number.isFinite(+modBlock.module_probability_after))
    ? +modBlock.module_probability_after
    : null;

  const allSteps = (() => {
    if (!modBlock) return [];
    if (Array.isArray(modBlock.steps)) return modBlock.steps;
    if (Array.isArray(modBlock.lines)) {
      return modBlock.lines.flatMap(ln => Array.isArray(ln.steps) ? ln.steps : []);
    }
    return [];
  })();
  const totalSteps  = allSteps.filter(s => Number.isFinite(+s.p_after));
  const stepsBelow1 = totalSteps.filter(s => +s.p_after < 0.90);

  console.log("Total Steps",stepsBelow1.length, totalSteps);

  

  // find category and info
  let categoryName = null;
  let info = null;
  for (const cat in moduleMetaData) {
    if (moduleMetaData[cat] && moduleMetaData[cat][cleanId]) {
      categoryName = cat;
      info = moduleMetaData[cat][cleanId];
      break;
    }
  }
container.html(
    `<div style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; padding:8px 12px;">` +
      `<span style="font-size:1.4rem; font-weight:700; color:var(--primary);">${cleanId}${info?.Description ? `: ${info.Description}` : ``}</span>` +
      `<span style="font-size:1.1rem; font-weight:600; color:var(--primary);">Confidence: <strong>${fmtP3(confAfter)}</strong></span>` +
      (totalSteps.length > 0 ? `<span style="font-size:1rem; font-weight:500; color:var(--primary);">Steps incomplete: ${stepsBelow1.length} / ${totalSteps.length}</span>` : ``) +
      (categoryName ? `<span style="font-size:0.9rem; font-weight:400; color:var(--primary);">${categoryName}</span>` : ``) +
      `<button id="open-kegg-btn" class="btn-primary" type="button" style="margin-top:4px;">Open on KEGG</button>` +
    `</div>`
  );

  document.getElementById("open-kegg-btn")?.addEventListener("click", () => {
    window.open(`https://www.kegg.jp/entry/${cleanId}`, "_blank", "noopener,noreferrer");
  });

}



function getFlatStepsForModule(moduleId) {
  const data = (window.moduleData || {})[moduleId];
  if (!data || typeof data !== "object") return [];

  if (Array.isArray(data.steps)) {
    return data.steps.map(s => ({
      line: 1,
      step: +s.step,
      equation: s.equation ?? "",
      p_before: s.p_before,
      p_after: s.p_after,
      best_path_kos: s.best_path_kos ?? null,
      best_path_reactions: s.best_path_reactions ?? null
    }));
  }

  if (Array.isArray(data.lines)) {
    const out = [];
    for (const ln of data.lines) {
      const lineNo = +ln.line || 1;
      const steps = Array.isArray(ln.steps) ? ln.steps : [];
      for (const s of steps) {
        out.push({
          line: lineNo,
          step: +s.step,
          equation: s.equation ?? "",
          p_before: s.p_before,
          p_after: s.p_after,
          best_path_kos: s.best_path_kos ?? null,
          best_path_reactions: s.best_path_reactions ?? null
        });
      }
    }
    return out;
  }

  return [];
}




function extractAllModulesWithAfter(rawSampleJson) {
  // Returns [{id, after, before, eqn}, ...] from a dict { M00017: {...}, ... }
  if (!rawSampleJson || typeof rawSampleJson !== 'object') return [];

  // If the sample JSON is actually one module block, no global list is possible:
  if ('module_probability_after' in rawSampleJson && !rawSampleJson.M00001) {
    return [];
  }

  const out = [];
  for (const [mid, block] of Object.entries(rawSampleJson)) {
    if (!block || typeof block !== 'object') continue;
    if (!/^M\d{5}$/.test(mid)) continue;

    const after = +block.module_probability_after;
    const before = +block.module_probability_before;

    out.push({
      id: mid,
      after: Number.isFinite(after) ? after : null,
      before: Number.isFinite(before) ? before : null,
      eqn: block.module_equation ?? null
    });
  }
  return out;
}

window.openModulesOverlayWhenReady = openModulesOverlayWhenReady;
window.openModulesOverlay = openModulesOverlay;
function openModulesOverlayWhenReady({ retries = 40, delayMs = 75 } = {}) {
  let tries = 0;

  const tick = () => {
    tries++;

    const raw = window.currentSampleJson;

    const looksLikeModuleDict =
      raw && typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).some(k => /^M\d{5}$/.test(k));

    if (looksLikeModuleDict) {
      openModulesOverlay();

      // metadata might finish loading later; re-render once or twice
      if (moduleMetaData === null) {
        setTimeout(renderModulesOverlayList, 250);
        setTimeout(renderModulesOverlayList, 900);
      }
      return;
    }

    if (tries < retries) setTimeout(tick, delayMs);
    else console.warn("Overlay not opened: window.currentSampleJson not ready / not module dict.");
  };

  tick();
}


function openModulesOverlay() {
  const overlay = document.getElementById("modules-overlay");
  if (!overlay) return;

  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");

  // defaults / restore saved
  const minInput = document.getElementById("modules-overlay-min");
  const maxInput = document.getElementById("modules-overlay-max");

  const savedMin = localStorage.getItem("blimmp_modules_overlay_min");
  const savedMax = localStorage.getItem("blimmp_modules_overlay_max");

  if (minInput) minInput.value = savedMin ?? "0.0";
  if (maxInput) maxInput.value = savedMax ?? "1.0";

  renderModulesOverlayList();
}

function closeModulesOverlay() {
  const overlay = document.getElementById("modules-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
}


function renderModulesOverlayList() {
  const body = document.getElementById("modules-overlay-body");
  const subtitle = document.getElementById("modules-overlay-subtitle");
  const filterInput = document.getElementById("modules-overlay-filter");

  const minInput = document.getElementById("modules-overlay-min");
  const maxInput = document.getElementById("modules-overlay-max");
  const errEl = document.getElementById("modules-overlay-thr-error");

  if (!body) return;

  const raw = window.currentSampleJson || null;

  const minVal = minInput ? +minInput.value : 0.0;
  const maxVal = maxInput ? +maxInput.value : 1.0;
  const filter = (filterInput?.value ?? "").trim().toUpperCase();

  // persist
  localStorage.setItem("blimmp_modules_overlay_min", String(minVal));
  localStorage.setItem("blimmp_modules_overlay_max", String(maxVal));

  // validate range
  const valid =
    Number.isFinite(minVal) &&
    Number.isFinite(maxVal) &&
    (maxVal > minVal);

  if (errEl) errEl.style.display = valid ? "none" : "inline";

  if (!valid) {
    if (subtitle) subtitle.textContent = `Invalid range (need Max > Min).`;
    body.innerHTML = `<div style="color:#666; font-size:13px;">
      Enter a valid confidence range (Max must be greater than Min).
    </div>`;
    return;
  }

  const all = extractAllModulesWithAfter(raw);

  const rows = all
    .filter(r => r.after != null && r.after >= minVal && r.after <= maxVal)
    .filter(r => !filter || r.id.toUpperCase().includes(filter))
    .sort((a, b) => (b.after ?? -Infinity) - (a.after ?? -Infinity));

  if (subtitle) {
    subtitle.textContent = all.length
      ? `${rows.length} / ${all.length} modules with confidence in [${minVal.toFixed(2)}, ${maxVal.toFixed(2)}]`
      : `No module list available (is window.currentSampleJson the full dict?)`;
  }

  if (!rows.length) {
    body.innerHTML = `<div style="color:#666; font-size:13px;">
    No modules in this confidence range.
    <div style="margin-top:6px; font-size:12px; color:#888;">
      (Make sure your uploaded JSON is shaped like { "M00001": {...}, "M00002": {...}, ... }
      and stored in <code>window.currentSampleJson</code>.)
      </div>
    </div>`;
    return;
  }

  // group rows by KEGG category
  const grouped = d3.group(
    rows,
    r => moduleToCategory.get(r.id) || "Uncategorized"
  );

  const sortedCategories = Array.from(grouped.keys()).sort();

  body.innerHTML = sortedCategories.map(cat => {
    const mods = grouped.get(cat);

    return `
      <div class="modules-overlay-category">
        ${cat}
        <span style="font-weight:400; color:#777;">(${mods.length})</span>
      </div>

      <div class="modules-list">
        ${mods.map(r => `
          ${(() => {
                const info = getModuleInfo(r.id);
                const desc = trunc25(info?.Description);
                return `
                  <div class="module-chip" data-mid="${r.id}" title="${info?.Description ? String(info.Description).replaceAll('"', '&quot;') : ''}">
                    <code>${r.id}</code>
                    ${desc ? `<div class="module-desc">${desc}</div>` : ``}
                    <div class="p">Confidence: <b>${(+r.after).toFixed(3)}</b></div>
                  </div>
                `;
              })()}

        `).join("")}
      </div>
    `;
  }).join("");

  body.querySelectorAll(".module-chip").forEach(el => {
    el.addEventListener("click", () => {
      const mid = el.getAttribute("data-mid");
      if (!mid) return;
      window.location.href = `index.html?module=${encodeURIComponent(mid)}`;
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("modules-overlay-close")?.addEventListener("click", closeModulesOverlay);
  document.querySelector("#modules-overlay .overlay-backdrop")?.addEventListener("click", closeModulesOverlay);

  document.getElementById("modules-overlay-open")?.addEventListener("click", () => {
    openModulesOverlay();
  });

  document.getElementById("nodeJsonUpload")?.addEventListener("change", () => {
    // Wait until your upload handler finishes setting window.currentSampleJson
    openModulesOverlayWhenReady();
  });

  document.getElementById("modules-overlay-refresh")?.addEventListener("click", renderModulesOverlayList);

  // live update
  document.getElementById("modules-overlay-min")?.addEventListener("input", renderModulesOverlayList);
  document.getElementById("modules-overlay-max")?.addEventListener("input", renderModulesOverlayList);
  document.getElementById("modules-overlay-filter")?.addEventListener("input", renderModulesOverlayList);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModulesOverlay();
  });
});


function buildStepMapFromModule(moduleId) {
  const steps = getFlatStepsForModule(moduleId);

  // KO -> queue of step placements
  const qmap = new Map(); // ko -> [{stepKey,line,step}, ...]

  for (const s of steps) {
    const lineNo = +s.line || 1;
    const stepNo = +s.step;
    if (!Number.isFinite(stepNo)) continue;

    const eq = String(s.equation ?? "");
    const matches = eq.match(/K\d{5}/g);
    if (!matches) continue;

    const stepKey = `L${lineNo}:S${stepNo}`;

    // IMPORTANT: do NOT dedupe with Set() — keep multiplicity across steps
    // but within the SAME step, you can dedupe to avoid double counting
    const uniqInThisStep = [...new Set(matches)];

    for (const ko of uniqInThisStep) {
      if (!qmap.has(ko)) qmap.set(ko, []);
      qmap.get(ko).push({ stepKey, line: lineNo, step: stepNo });
    }
  }

  // convert lists to queues
  const out = new Map();
  for (const [ko, arr] of qmap.entries()) {
    // stable ordering: line then step
    arr.sort((a,b)=> (a.line-b.line) || (a.step-b.step));
    out.set(ko, arr);
  }
  return out; // KO -> array of placements
}







// Compute SVG dimensions
function getSvgDims() {
  const w = Math.min(MAX_SVG_W, window.innerWidth - 20);
  return { w, h: BASE_SVG_H };
}


// Put this OUTSIDE renderGraph (top-level in the module)
let _resizeHandlerInstalled = false;

function installResizeHandlerOnce() {
  if (_resizeHandlerInstalled) return;
  _resizeHandlerInstalled = true;

  let _rzTimer = null;
  window.addEventListener("resize", () => {
    if (!window.currentModuleId || !currentNodes?.length) return;
    clearTimeout(_rzTimer);
    _rzTimer = setTimeout(() => {
      renderGraph(currentNodes, currentLinks, window.currentBestPath, window.currentModuleId);
    }, 150);
  });
}

function buildBestPathKoSet(moduleBlock, moduleId) {
  const set = new Set();

  // 1) Prefer the uploaded module block's top-level best_path (your sample)
  const bp = moduleBlock?.best_path;
  const arr1 =
    Array.isArray(bp) ? bp :
    String(bp ?? "")
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean);

  for (const ko of arr1) {
    const base = KO_BASE(KO_ID(ko));
    if (base && base !== "START" && base !== "SINK") set.add(base);
  }

  // 2) Fallback: step-level best_path_kos (your equations JSON)
  if (set.size === 0) {
    const steps = getFlatStepsForModule(moduleId);
    for (const s of steps) {
      const best = s?.best_path_kos;
      const arr2 =
        Array.isArray(best) ? best :
        String(best ?? "")
          .split(/[,\s]+/)
          .map(x => x.trim())
          .filter(Boolean);

      for (const ko of arr2) {
        const base = KO_BASE(KO_ID(ko));
        if (base && base !== "START" && base !== "SINK") set.add(base);
      }
    }
  }

  return set;
}

function rebuildKoIndexFromCurrentSampleJson(){
  const raw = window.currentSampleJson;
  const idx = new Map();
  for (const [mid, block] of Object.entries(raw || {})) {
    if (!/^M\d{5}$/.test(mid)) continue;
    const nodes = block?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      const base = KO_BASE(NODE_ID(n));
      if (!base || base === "START" || base === "SINK") continue;
      const prev = idx.get(base);
      const prevHas = prev && prev.Dk != null;
      const curHas  = n && n.Dk != null;
      if (!prev || (!prevHas && curHas)) idx.set(base, n);
    }
  }
  window.koIndex = idx;
  console.log("koIndex built:", idx.size);
}

// Main function
export function renderGraph(rawNodes, rawLinks, bestPath, moduleId) {
  console.log("renderGraph called:", moduleId);
  const moduleData = (window.currentModuleJson || {})[moduleId] || {};
  const stepMap = buildStepMapFromModule(moduleId);
  const koUseCount = new Map();
  const overlay = window.currentOverlayBlock || null;

  // build baseKO -> overlayNode map (suffix-agnostic)
  const overlayByBase = new Map();
  if (overlay && Array.isArray(overlay.nodes)) {
    for (const on of overlay.nodes) {
      const base = KO_BASE(KO_ID(on["KO id"] ?? on.id));
      if (!base) continue;
      overlayByBase.set(base, on);
    }
  }

  // merge onto rawNodes (Oct27 nodes have id like K00855_1)
  rawNodes.forEach(n => {
    const base = KO_BASE(KO_ID(NODE_ID(n)));   // base from Oct27 id
    const ov = overlayByBase.get(base);
    if (!ov) return;

    // copy over ONLY the metric fields you need
    // (keeps Oct27 id/suffix intact!)
    const fields = [
      "Dk","Dk_Neighbor","E-value","score","hit_conf",
      "flag_is_below_kofam_threshold","is_outcompeted",
      "kofam_score_threshold","buddy_stats","modules_present",
      "target name","overlapgroup_winner","overlapgroup_winner_score",
      "overlapgroup_winner_hit_conf","KO_freq","KO_Occurrence"
    ];

    for (const k of fields) {
      if (ov[k] !== undefined) n[k] = ov[k];
    }

    // also allow uploaded to provide "KO id" if Oct27 lacks it
    if (n["KO id"] == null && ov["KO id"] != null) n["KO id"] = ov["KO id"];
  });



  // step hover info: step
  const rawMod = window.currentModuleJson || {};
  const moduleBlock =
    (rawMod && (rawMod.module_equation || rawMod.module_probability_before != null))
      ? rawMod
      : (rawMod && rawMod[moduleId]) ? rawMod[moduleId] : null;


      // Prefer per-sample module block (has p_before/p_after), fallback to moduleData (equations only)
    function flatStepsFromBlock(block) {
      if (!block || typeof block !== "object") return [];

      if (Array.isArray(block.steps)) {
        return block.steps.map(s => ({
          line: 1,
          step: +s.step,
          equation: s.equation ?? "",
          p_before: s.p_before,
          p_after: s.p_after,
          best_path_kos: s.best_path_kos ?? null,
          best_path_reactions: s.best_path_reactions ?? null
        }));
      }

      if (Array.isArray(block.lines)) {
        const out = [];
        for (const ln of block.lines) {
          const lineNo = +ln.line || 1;
          const steps = Array.isArray(ln.steps) ? ln.steps : [];
          for (const s of steps) {
            out.push({
              line: lineNo,
              step: +s.step,
              equation: s.equation ?? "",
              p_before: s.p_before,
              p_after: s.p_after,
              best_path_kos: s.best_path_kos ?? null,
              best_path_reactions: s.best_path_reactions ?? null
            });
          }
        }
        return out;
      }
      return [];
    }


    const stepInfoSource = (() => {
      const fromBlock = flatStepsFromBlock(moduleBlock);
      if (fromBlock.length) return fromBlock;
      return getFlatStepsForModule(moduleId); // your existing function (equations JSON)
    })();

    const stepInfoByKey = new Map(
      stepInfoSource
        .filter(s => Number.isFinite(+s.step))
        .map(s => [`L${(+s.line || 1)}:S${+s.step}`, s])
    );

  rebuildKoIndexFromCurrentSampleJson()

  currentLinks = rawLinks;

  const { w: SVG_W, h: SVG_H } = getSvgDims();

  const root = d3.select('#graph-container').html('').style('overflow', 'visible');

  // Allow drawing outside the svg’s content box
  root.style('overflow', 'visible');                       // container
  const VB_BLEED_TOP = 50;   // increase if you still can’t see the \ top
  const VB_BLEED_LEFT = 60;
  const VB_BLEED_RIGHT = 60;
  const VB_BLEED_BOTTOM = 40;

  const svgRoot = root.append('svg')
    .attr('width', SVG_W)
    .attr('height', SVG_H)
    // start viewBox above/left of 0,0 so negative coords are visible
    .attr('viewBox', `${-VB_BLEED_LEFT} ${-VB_BLEED_TOP} ${SVG_W + VB_BLEED_LEFT + VB_BLEED_RIGHT} ${SVG_H + VB_BLEED_TOP + VB_BLEED_BOTTOM}`)
    .style('overflow', 'visible')
    .style('margin', `${TOP_OFFSET}px auto 0`);

  const svg = svgRoot.append('g'); 
  // arrowhead marker
  const defs = svg.append('defs');

  const legendRoot = d3.select("#legend-overlay")
  .html("")
  .append("svg")
  .attr("width", 360)   // width of legend block
  .style("overflow", "visible");

  const legendSvg = legendRoot.append("g");

  addLegends(legendSvg, SVG_W, { inLegendRow: true });

  const pad = 12;
  const bb = legendSvg.node().getBBox();
  legendRoot
    .attr("height", Math.ceil(bb.y + bb.height + pad));



defs.append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '-0 -5 10 10')
    .attr('refX', 8)                // push the arrow tip just beyond the end of your path
    .attr('refY', 0)
    .attr('orient', 'auto')         // rotate to match path direction
    .attr('markerUnits', 'strokeWidth') // scales marker size with stroke width
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
  .append('path')
    .attr('d', 'M 0,-5 L 10,0 L 0,5')  // triangle
    .attr('fill', 'currentColor');

  // Added Sep 4
  const occExtent = d3.extent(rawNodes, d => d.KO_freq ?? d.KO_Occurrence ?? 0);

  window.sharedScales = {
    rScale: d3.scaleLinear().domain(occExtent).range([5,20]),
    dkScale: d3.scaleSequential(d3.interpolateReds).domain([0,1]),
    evScale: d3.scaleSequential()
                .domain([-50, 0])                     // log10(E)
                .interpolator(d3.interpolateRgb("#ff0000", "white"))
                .clamp(true),
  };

  // Layout + render
  console.log("In rendergraph")
  console.log("RAW NODE[0] keys:", Object.keys(rawNodes?.[0] || {}), rawNodes?.[0]);
  console.log("RAW LINK[0]:", rawLinks?.[0]);

  const layout = sugiyamaLayout(rawNodes, rawLinks);
  currentNodes = layout.nodes;
  currentLinks = layout.links;

  // Call immediately, then retry once metadata finishes loading if it wasn't ready
  displayModuleInfo(moduleId);
  if (!moduleMetaData) {
    const retryId = moduleId;
    const retryBlock = window.currentModuleBlock;
    const iv = setInterval(() => {
      if (moduleMetaData) {
        clearInterval(iv);
        window.currentModuleBlock = retryBlock;
        displayModuleInfo(retryId);
      }
    }, 80);
  }

  layout.nodes.forEach(n => {
  const full = KO_ID(NODE_ID(n));   // e.g., K01601_3
  const base = KO_BASE(full);       // e.g., K01601

  const placements = stepMap.get(base) || null;
  const used = koUseCount.get(base) || 0;

  const hit =
    (placements && placements[used]) ? placements[used]
    : (placements ? placements[placements.length - 1] : null);

  koUseCount.set(base, used + 1);

  n.stepKey  = hit?.stepKey ?? null;
  n.stepLine = hit?.line ?? null;
  n.stepNo   = hit?.step ?? null;
});



  const focus = ["K11532", "K01086"];
  layout.nodes
    .filter(n => focus.includes(KO_BASE(NODE_ID(n))))
    .forEach(n => console.log("NODE", NODE_ID(n), "x,y", n.x, n.y, "stepKey", n.stepKey));


// --- after you assign n.stepKey, n.stepLine, n.stepNo ---
// Use Dagre layout Y; step lines are drawn slightly BELOW the lowest node in each stepKey
const nodesWithStep = layout.nodes.filter(n => Number.isFinite(n.y) && n.stepKey);

// yMax per stepKey (bottom-most node in that step)
const yMaxByStepKey = d3.rollup(
  nodesWithStep,
  v => d3.max(v, d => d.y),
  d => d.stepKey
);

const bottomNodeByStepKey = d3.rollup(
  nodesWithStep,
  v => {
    return v.reduce((best, n) => {
      const bestBottom = (best?.y ?? -Infinity) + (best?.r ?? best?.size ?? 0);
      const nBottom    = n.y + (n.r ?? n.size ?? 0);
      return nBottom > bestBottom ? n : best;
    }, null);
  },
  d => d.stepKey
);
// xMin/xMax per stepKey (for shortening multiline step lines)
const xExtentByStepKey = d3.rollup(
  nodesWithStep,
  v => [d3.min(v, d => d.x), d3.max(v, d => d.x)],
  d => d.stepKey
);


// stable order (your existing sort)
const stepKeys = Array.from(yMaxByStepKey.keys()).sort((a,b) => {
  const ma = a.match(/L(\d+):S(\d+)/), mb = b.match(/L(\d+):S(\d+)/);
  if (!ma || !mb) return String(a).localeCompare(String(b));
  const [la, sa] = ma.slice(1).map(Number);
  const [lb, sb] = mb.slice(1).map(Number);
  return la - lb || sa - sb;
});

// Group nodes by step

// NEW: detect multiline
const stepLinesG = svg.insert('g', ':first-child')
  .attr('class', 'step-lines')
  .attr('pointer-events', 'all');

const bestColG = svg.append("g")
  .attr("class", "best-path-col")
  .attr("pointer-events", "all");
  
// Position inside the right padding area
const BEST_X = SVG_W - PAD_R + 20;

const fullLine = d3.line().x(d => d.x).y(d => d.y);

// Detect multiline ONCE (this is the only multiline logic we keep)
const modData = (window.moduleData || {})[moduleId];
const isMultiline = !!(modData && Array.isArray(modData.lines) && modData.lines.length > 1);

stepKeys.forEach(key => {
  //const yMax = yMaxByStepKey.get(key);
  //if (!Number.isFinite(yMax)) return;

  const OFFSET = 35; // how far below the last node in that step
  //let yLine = yMax + OFFSET;
  
  //yLine = Math.min(yLine, BASE_SVG_H - PAD_B - 2); // clamp to canvas
  const bottomNode = bottomNodeByStepKey.get(key);
  if (!bottomNode) return;

  const r = window.sharedScales.rScale(
  bottomNode.KO_freq ?? bottomNode.KO_Occurrence ?? 0
);
  let yLine = bottomNode.y + r + OFFSET;

  yLine = Math.min(yLine, BASE_SVG_H - PAD_B - 2);


  const stepDatum = stepInfoByKey.get(key) || null;
  const eq = stepDatum?.equation ?? "—";
  const pB = stepDatum?.p_before;
  const pA = stepDatum?.p_after;

  const best = stepDatum?.best_path_kos;
  const bestKosArr =
  Array.isArray(best) ? best
  : String(best ?? "")
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
      
  const bestRxn = stepDatum?.best_path_reactions;
  const bestRxnStr = Array.isArray(bestRxn) ? bestRxn.join(", ") : (bestRxn ?? "—");
  console.log(bestRxnStr)
  console.log("best reaction")

  const rxnList = Array.isArray(bestRxn)
  ? bestRxn
  : String(bestRxn ?? "")
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean);

  const rxnLinksHtml = rxnList.length
    ? rxnList
        .map(r => {
          const clean = r.trim();
          return `<a href="${keggRxnLink(clean)}"
                    target="_blank"
                    rel="noopener noreferrer"
                    style="color:#4f86c1; text-decoration:underline;">
                    ${clean}
                  </a>`;
        })
        .join(", ")
    : "—";
    

  // Parse line/step from key
  const m = key.match(/L(\d+):S(\d+)/);
  const lineNo = m ? +m[1] : 1;
  const stepNo = m ? +m[2] : null;

  const showStepTip = (event) => {
    tooltip.transition().duration(100).style('opacity', 0.98);

    const header = isMultiline
      ? `Line ${lineNo} • Step ${stepNo ?? "—"}`
      : `Step ${stepNo ?? "—"}`;

    tooltip.html(
      `<div style="font-weight:600;  white-space:pre-wrap; word-break:break-word;overflow-wrap: anywhere;">${header}</div>` +
      `<div style="margin-top:4px;"><b>p_before</b>: ${fmtP3(pB)} &nbsp;•&nbsp; <b>p_after</b>: ${fmtP3(pA)}</div>` +
      `<div style="margin-top:6px;"><b>equation</b>:</div>` +
      `<pre style="margin:4px 0 0 0; white-space:pre-wrap; word-break:break-word;overflow-wrap: anywhere;">${eq}</pre>`

    )
    .style('left', (event.pageX + 8) + 'px')
    .style('top',  (event.pageY - 28) + 'px');
  };

  const hideStepTip = () => tooltip.transition().duration(250).style('opacity', 0);

  // FULL WIDTH always (reverted)
  let x1 = 20;
  let x2 = SVG_W;

  if (isMultiline) {
  const ext = xExtentByStepKey.get(key);
  if (ext && Number.isFinite(ext[0]) && Number.isFinite(ext[1])) {
    const PAD_X = 40;
    x1 = Math.max(20, ext[0] - PAD_X);
    x2 = Math.min(SVG_W, ext[1] + PAD_X);
  }
}

const bestX = isMultiline ? Math.min(SVG_W - 6, x2 + 8) : BEST_X;
const bestAnchor = isMultiline ? "start" : "start"; // (or "start" always)
// ---- Best-path KOs as a vertical list ABOVE the step line ----
const koX = isMultiline ? (x2 + 50) : (x2 + 50);   // anchor near end of line
const koAnchor = "end";
const koFont = 11;
const koLineH = 12;         // line height in px
const koGapAboveLine = 6;   // space between last KO and the dashed line

const showBestTip = (event) => {
  tooltip.transition().duration(100).style("opacity", 0.98);
  tooltip.html(
    `<div style="font-weight:600;">Best path</div>` +
    `<div style="margin-top:4px;"><b>KOs</b>: ${linkifyKOsToKegg(bestKosArr.join(", "))}</div>` +
    `<div style="margin-top:4px;"><b>Reactions</b>: ${rxnLinksHtml}</div>`
  )
  .style("left", (event.pageX + 8) + "px")
  .style("top",  (event.pageY - 28) + "px");
};

const hideBestTip = () => tooltip.transition().duration(250).style("opacity", 0);

// limit how many lines you print so it doesn't explode tall
const maxLines = 6;
const kosToShow = bestKosArr.slice(0, maxLines);
const more = bestKosArr.length - kosToShow.length;

if (kosToShow.length) {
  const text = stepLinesG.append("text")
    .attr("x", koX*2)
    // place the *last* line just above the step line, then tspans go upward
    .attr("y", yLine - koGapAboveLine - (kosToShow.length - 1) * koLineH)
    .attr("text-anchor", koAnchor)
    .attr("font-size", koFont)
    .attr("fill", "#444")
    .style("cursor", "help")
    .on("mousemove", showBestTip)
    .on("mouseout", hideBestTip);

  kosToShow.forEach((ko, i) => {
    text.append("tspan")
      .attr("x", koX)
      .attr("dy", i === 0 ? 0 : koLineH)
      .text(ko);
  });

  if (more > 0) {
    text.append("tspan")
      .attr("x", koX)
      .attr("dy", koLineH)
      .text(`… (+${more})`);
  }
}
  // dashed line
  stepLinesG.append('path')
    .attr('d', fullLine([{ x: x1, y: yLine }, { x: x2, y: yLine }]))
    .attr('stroke', '#9aa0a6')
    .attr('stroke-dasharray', '4,4')
    .attr('stroke-width', 1)
    .attr('fill', 'none')
    .style('cursor', 'help')
    .on('mousemove', showStepTip)
    .on('mouseout', hideStepTip);

// label position: stick to the start of the shortened line for multiline
const labelX = isMultiline ? Math.max(10, x1 - 10) : 10;

// label
const labelText = isMultiline ? `L${lineNo}` : `Step ${stepNo ?? "—"}`;

  stepLinesG.append('text')
    .attr('x', labelX)
    .attr('y', yLine - 6)
    .attr('text-anchor', 'start')
    .attr('font-size', 15)
    .attr('fill', '#333435ff')
    .style('cursor', 'help')
    .text(`${labelText} ⓘ`)
    .on('mousemove', showStepTip)
    .on('mouseout', hideStepTip);

  // p_before/p_after visible right on the plot
  stepLinesG.append('text')
    .attr('x', labelX)
    .attr('y', yLine + 12)
    .attr('text-anchor', 'start')
    .attr('font-size', 12)
    .attr('fill', '#555')
    .text(`p_before: ${fmtP3(pB)} • p_after: ${fmtP3(pA)}`);});

  const bestSet = buildBestPathKoSet(moduleBlock, moduleId);
  window.bestPathKos = bestSet;

  console.log("bestSet size:", bestSet.size, "sample:", [...bestSet].slice(0, 15));
  plotLinks(layout.links, svg, bestSet);
  plotNodes(layout.nodes, svg);
  //addLegends(svg, SVG_W);

  renderModuleSummary(window.currentModuleJson || {}, moduleId);

  
  installResizeHandlerOnce();
  installTooltipExpandHandlerOnce();
}

// Sugiyama layout
function sugiyamaLayout(rawNodes, rawLinks) {

   const nodes = rawNodes.map(n => ({
  ...n,
  // IMPORTANT: layout key must match link endpoints (which are like K00410_3)
  // So prefer the raw .id (Oct27 suffix id) for layout, and only fallback if missing.
  _key: KO_ID(n?.id ?? n?.["KO id"]),
}));


  const nodeKeys = new Set(nodes.map(n => n._key));

   const links = rawLinks.map(l => ({
  ...l,
  _src: KO_ID(typeof l.source === "object" ? (l.source?.id ?? l.source?.["KO id"]) : l.source),
  _tgt: KO_ID(typeof l.target === "object" ? (l.target?.id ?? l.target?.["KO id"]) : l.target),
}));


  // 1. Build Dagre graph
    const g = new dagre.graphlib.Graph()
    .setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 160 })
    .setDefaultEdgeLabel(() => ({}));

  // 2. Add nodes (force string keys, trimmed)

  nodes.forEach(n => g.setNode(n._key, { width: 40, height: 40 }));

  console.log("NODE_KEY sample:", nodes.slice(0, 12).map(n => ({
  id: n.id,
  "KO id": n["KO id"],
    _key: n._key
  })));

  const missing = [];
  for (const l of links) {
    if (!nodeKeys.has(l._src)) missing.push({ side: "src", id: l._src, raw: l.source });
    if (!nodeKeys.has(l._tgt)) missing.push({ side: "tgt", id: l._tgt, raw: l.target });
  }
  if (missing.length) console.warn("Missing endpoints (first 20):", missing.slice(0,20));




  // 3. Add edges (suffix-preserving)
    links.forEach(l => {
    const srcIn = nodeKeys.has(l._src);
    const tgtIn = nodeKeys.has(l._tgt);
    if (!srcIn || !tgtIn) {
      l._skip = true;
      console.warn("Skipping link with missing endpoint:", { l, srcIn, tgtIn });
      return;
    }
    g.setEdge(l._src, l._tgt);
  });


  // 4. Run layout
  dagre.layout(g);

  

  // 5. Build scales once
  const { w: SVG_W } = getSvgDims();
  const { width: gW, height: gH } = g.graph();
  const EXTRA_TOP = 0;              // more headroom above rank 0
  const EXTRA_BOTTOM = 0;            // small buffer below
  const xScale = d3.scaleLinear().domain([0, gW]).range([PAD_L, SVG_W - PAD_R]);
  const yScale = d3.scaleLinear()
    .domain([-EXTRA_TOP, gH + EXTRA_BOTTOM])
    .range([PAD_T, BASE_SVG_H - PAD_B]);


  // 6. Assign x/y to each node
  nodes.forEach(n => {
  const p = g.node(n._key);
  if (!p) {
    n.x = PAD_L;
    n.y = PAD_T;
    return;
  }
  n.x = xScale(p.x);
  n.y = yScale(p.y);
});


  


  // 7. Compute & attach scaled points
  links.forEach(l => {
    if (l._skip) {
      l.points = [ { x: PAD_L, y: PAD_T }, { x: PAD_L+10, y: PAD_T+10 } ];
      return;
    }
    const e = g.edge(l._src, l._tgt);
    let pts = (e && e.points) ? e.points : [];
    pts = pts.map(pt => ({ x: xScale(pt.x), y: yScale(pt.y) }))
            .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) {
      pts = [ { x: PAD_L, y: PAD_T }, { x: PAD_L+10, y: PAD_T+10 } ];
    }
    l.points = pts;
  });


  return { nodes, links };
}

function normBool(v, dflt=false){ return v === true ? true : v === false ? false : dflt; }
function normNum(v, dflt=null){ const x = +v; return Number.isFinite(x) ? x : dflt; }
function normStr(v, dflt="—"){ return (v == null || v === "") ? dflt : String(v); }

function fmtE(v){
  if (v == null || !isFinite(+v)) return "—";
  if (+v === 100.0) return "NA";
  return (+v < 1e-3) ? (+v).toExponential(1) : (+v).toFixed(4);
}

function log10EForColor(ev, floorLog10 = -50) {
  const x = +ev;

  if (!Number.isFinite(x)) return null;  // missing / NaN  invalid grey

  if (x === 0) {
    // special case: perfect hit treat as 1e-50
    return floorLog10;
  }

  // Optional: treat your sentinel 100.0 as NA grey
  if (x === 100.0) {
    return null;
  }

  if (x <= 0) return null;  // negative or zero (besides exact 0 above) invalid

  return Math.log10(x);
}



function plotNodes(nodes, svg) {
  window.nodeById = new Map();
  window.nodeByBase = new Map();
  const occExtent = d3.extent(nodes, d => d.KO_freq ?? d.KO_Occurrence ?? 0);
  const occScale = d3.scaleSequential(t => d3.interpolateGreys(0.3 + 0.8 * t)).domain(occExtent);
 //const dkScale = d3.scaleSequential(d3.interpolateReds).domain([0,1]);
/*   const evScale = d3.scaleSequential()
    .domain([-50, 0])
    .interpolator(d3.interpolateRgb("#ff0000","white"))
    .clamp(true); */


  const { rScale, dkScale, evScale } = window.sharedScales;
  
  const nodeG = svg.append('g').attr('class','nodes');

  nodeG.selectAll('g.node').data(nodes).enter().append('g')
    .attr('class','node')
    .attr('transform', d=>`translate(${d.x},${d.y})`)
    .each(function(d) {
      const g = d3.select(this);
      const r = rScale(d.KO_freq ?? d.KO_Occurrence ?? 0);
      const fullId = KO_ID(NODE_ID(d));     // e.g., K01601_3
      const baseId = KO_BASE(fullId);       // e.g., K01601

      // 1) Full-id map (unique per node)
      window.nodeById = window.nodeById || new Map();
      window.nodeById.set(fullId, d);

      // 2) Base-id map (store all copies, not just the last one)
      window.nodeByBase = window.nodeByBase || new Map();
      if (!window.nodeByBase.has(baseId)) window.nodeByBase.set(baseId, []);
      window.nodeByBase.get(baseId).push(d);


      g.attr("data-ko", baseId)
      .classed("flag-below", d.flag_is_below_kofam_threshold === true)
      .classed("flag-out",   d.is_outcompeted === true);

      // Force START and SINK to be black
      if (baseId === 'START' || baseId === 'SINK') {
        g.append('circle')
          .attr('r', r)
          .attr('fill', 'black')
          .attr('stroke', 'black')
          .attr('stroke-width', 1);
      } else if (d.Dk == null) {
        g.append('circle')
          .attr('r', r)
          .attr('fill', occScale(d.KO_Occurrence))
          .attr('stroke','black')
          .attr('stroke-width',1);
      } else {
        // Blue half
        g.append('path')
          .attr('d', d3.arc().innerRadius(0).outerRadius(r)({
            startAngle:-Math.PI/2, endAngle:Math.PI/2
          }))
          .attr('fill', dkScale(window.useDkAfter ? d.Dk_Neighbor : d.Dk));

        // Red half
        const ev = d['E-value'];
        const t  = log10EForColor(ev);    // handles 0 vs invalid
        const fillColor = (t == null ? "#888888" : evScale(t));

        g.append('path')
          .attr('d', d3.arc().innerRadius(0).outerRadius(r)({
            startAngle:  Math.PI/2,
            endAngle:    3*Math.PI/2
          }))
          .attr('fill', fillColor);


        // Divider and outline
        g.append('line')
          .attr('x1', -r).attr('y1', 0)
          .attr('x2', r).attr('y2', 0)
          .attr('stroke', 'black')
          .attr('stroke-width', 1);
        g.append('circle')
          .attr('r', r)
          .attr('fill','none')
          .attr('stroke','black')
          .attr('stroke-width',1);
      }

      g.append('text')
        .text(baseId === "SINK" ? "END" : baseId)
        .attr('text-anchor', 'middle')
        .attr('y', r + 14)
        .attr('font-size', '12px')
        .attr('fill', '#000')
        .attr('pointer-events', 'none');


      // --- Visual flags for dubious / outcompeted KOs ---
      const flagged = (d.is_outcompeted === true) || (d.flag_is_below_kofam_threshold === true);

      // Red outline if either flag is true
      if (flagged) {
      g.append('circle')
        .attr('class', 'flag-outline')
        .attr('r', r + 2)
        .attr('fill', 'none')
        .attr('stroke', ' #EC6535')
        .attr('stroke-width', 1.5);
      }

      // Symbol indicators above node
      if (d.is_outcompeted === true && d.flag_is_below_kofam_threshold === false) {
        // show “?” for outcompeted only
        g.append('text')
          .text('?')
          .attr('x', -(r + 8))          // small offset above circle
          .attr('text-anchor', 'middle')
          .attr('font-size', '22px')
          .attr('font-weight', 'bold')
          .attr('fill', '#ff7f50');
      } else if (d.is_outcompeted === false && d.flag_is_below_kofam_threshold === true) {
        // show “!” for below-KOfam only
        g.append('text')
          .text('!')
          .attr('x', -(r + 8))
          .attr('text-anchor', 'middle')
          .attr('font-size', '22px')
          .attr('font-weight', 'bold')
          .attr('fill', '#DD4400');
      } else if (d.is_outcompeted === true && d.flag_is_below_kofam_threshold === true) {
        // show “x” for below-KOfam only
        g.append('text')
          .text('x')
          .attr('x', -(r + 8))
          .attr('text-anchor', 'middle')
          .attr('font-size', '15px')
          .attr('font-weight', 'bold')
          .attr('fill', '#DD4400');
      }

      if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
      tooltip.interrupt();


     // Tooltip
      g.on("mouseenter", (event) => {
        if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
        tooltip.interrupt();

        tooltip.style("opacity", 0.98);


        const base   = baseId;
        const Pi = d.Dk; 
        const Oi = d.hit_conf;  
        const ev     = d['E-value'];
        const score = d['score'];                     
        const Fi = d.KO_freq;
        const ORF = d['target name'];

        const dkp    = d.Dk_Neighbor;
        const isOut   = normBool(d.is_outcompeted, false);
        const isBelow = normBool(d.flag_is_below_kofam_threshold, false);
        const showFlagsOnly = isOut && isBelow;

        const ogw    = normStr(d.overlapgroup_winner, '—');               // Overlap winner value
        const ogws   = normNum(d.overlapgroup_winner_score, null);
        const kofThr = normNum(d.kofam_score_threshold, null);

        // prefer your stored shift if present (this matches panel’s “+ shift”)
        const shift =
          (d?.buddy_stats && Number.isFinite(+d.buddy_stats.shift))
            ? +d.buddy_stats.shift
            : (Number.isFinite(+dkp) && Number.isFinite(+Pi) ? (+dkp - +Pi) : null);

        const shiftStr =
          (shift == null || !Number.isFinite(shift)) ? "—"
          : (shift >= 0 ? `+${shift.toPrecision(3)}` : `${shift.toPrecision(3)}`);


        let html = `
        <div style="line-height:1.3;">
          <div>
            <strong>KO:</strong>
            <a href="${keggKoLink(base)}"
              target="_blank"
              rel="noopener noreferrer"
              style="color:#4f86c1; text-decoration:underline;">
              ${base}
            </a>
          </div>
          <div><strong>On ORF:</strong> ${ORF ?? "—"}</div>
        </div>
      `;

        const sep = `<hr style="margin:6px 0; border:none; border-top:1px solid #e5e5e5;"/>`;

        const flagIcon = () => {
          if (isOut && isBelow) return `<span style="color:#DD4400; font-weight:800;">x</span>`;
          if (isBelow)          return `<span style="color:#DD4400; font-weight:800;">!</span>`;
          if (isOut)            return `<span style="color:#ff7f50; font-weight:800;">?</span>`;
          return "";
        };

        const flagsLine = (flagged || isOut || isBelow) ? `
          ${sep}
          <div style="font-weight:300; margin-bottom:2px;">${flagIcon()}</div>
          <div style="
            margin-left:8px;
            font-size:18px;
            line-height:1;
            display:flex;
            gap:6px;
            align-items:center;
          ">
          </div>
        ` : "";

const expandBtn = `
  <a
    href="#"
    class="tooltip-expand-btn"
    data-ko="${base}"
    style="
      margin-left:6px;
      font-size:15px;
      font-weight:900;
      color:#666;
      text-decoration:none;
      cursor:pointer;
      vertical-align:middle;
    "
    title="Open influence panel"
  >⤴︎</a>
`;




// Score line: value + inline flag annotation if flagged
        const scoreFlagAnnotation = (() => {
          if (isBelow && isOut) {
            return ` <span style="color:#DD4400; font-weight:800;">x</span>`
              + ` <span style="font-size:12px; color:#DD4400;">KOfam threshold: ${kofThr == null ? "—" : kofThr}</span>`;
          }
          if (isBelow) {
            return ` <span style="color:#DD4400; font-weight:800;">!</span>`
              + ` <span style="font-size:12px; color:#DD4400;">KOfam threshold: ${kofThr == null ? "—" : kofThr}</span>`;
          }
          if (isOut) {
            return ` <span style="color:#ff7f50; font-weight:800;">?</span>`;
          }
          return "";
        })();

        // Better hits for this ORF (outcompeted case)
        const betterHitsBlock = (() => {
          if (!isOut) return "";

          // gather competitor KOs from koIndex / nodeByBase for same ORF
          const orfName = normStr(d["target name"], "");
          if (!orfName || orfName === "—") return "";

          // collect all nodes that share the same ORF target name
          const rivals = [];
          if (window.koIndex) {
            for (const [koBase, nDatum] of window.koIndex.entries()) {
              if (koBase === base) continue;
              if (normStr(nDatum["target name"], "") === orfName) {
                rivals.push({ ko: koBase, score: nDatum.score ?? nDatum["score"] });
              }
            }
          }

          // fallback: use overlapgroup_winner directly
          if (!rivals.length && ogw && ogw !== "—" && ogw !== base) {
            // find its score from nodeByBase
            const winnerArr = window.nodeByBase?.get(ogw);
            const winnerDatum = winnerArr?.length ? winnerArr[0] : null;
            rivals.push({ ko: ogw, score: winnerDatum?.score ?? winnerDatum?.["score"] });
          }

          if (!rivals.length) return "";

          const rows = rivals
            .sort((a, b) => {
              const sa = (a.score == null || !isFinite(+a.score)) ? -Infinity : +a.score;
              const sb = (b.score == null || !isFinite(+b.score)) ? -Infinity : +b.score;
              return sb - sa;
            })
            .slice(0, 1)
            .map(rv =>
              `<div style="margin-left:8px;">` +
                `<a href="${keggKoLink(rv.ko)}" target="_blank" rel="noopener noreferrer" ` +
                  `style="color:#4f86c1; text-decoration:underline;">${rv.ko}</a>` +
                `: ${rv.score == null ? "—" : rv.score}` +
              `</div>`
            )
            .join("");

          return `${sep}<div style="font-weight:600;">${flagIcon()} Better hits for this ORF:</div>${rows}`;
        })();

        const hitAndPi = `
  <div style="line-height:1.3;">

    ${sep}

    <div><b>Confidence (P<sub>i</sub>′):</b> ${fmtP3(dkp)}</div>
    <div><b>ATB Frequency (F<sub>i</sub>):</b> ${fmtP3(Fi)}</div>

    ${sep}

    <div style="font-weight:600;">Calculation Inputs</div>
    <div style="margin-left:8px;">
      <div>KO Score: ${score ?? "—"}${scoreFlagAnnotation}</div>
      <div>E-value: ${fmtE(ev)}</div>
      <div>Annotation Confidence (O<sub>i</sub>): ${fmtP3(Oi)}</div>
    </div>


    ${betterHitsBlock}

    ${sep}

    <div><b>Raw Confidence (P<sub>i</sub>):</b> ${fmtP3(Pi)}</div>
    <div style="font-weight:600;">Influencer shift: ${shiftStr} ${expandBtn}</div>

  </div>
`;

        html += hitAndPi;



        tooltip.html(html)
          moveTooltipToEvent(event, 5, 28);
      })
      .on("mousemove", (event) => {
  moveTooltipToEvent(event);
}).on("mouseleave", (event) => {
  // If leaving node INTO tooltip, do not hide.
  const toEl = event.relatedTarget;
  if (toEl && tooltip.node().contains(toEl)) return;

  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    // if tooltip is currently hovered, don’t hide
    if (tooltip.node().matches(":hover")) return;
    tooltip.transition().duration(120).style("opacity", 0);
  }, 40);
});


      g.on("click", (event, d) => {
      renderInfluencePanelForSink(d); 
      });
    });
}

// Plot links
function plotLinks(links, svg, bestSet) {
  const valid = (links || []).filter(l =>
    Array.isArray(l.points) &&
    l.points.length >= 2 &&
    l.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))
  );

  console.log("plotLinks: total", links?.length, "valid", valid.length, "skipped", (links||[]).filter(l=>l._skip).length);


  const eo = valid.map(d => +d.edge_occurence).filter(v => Number.isFinite(v));
  const occExtent = eo.length ? d3.extent(eo) : [0, 1];

  const colorScale = d3.scaleSequential(t => d3.interpolateGreys(0.5 + 0.8*t))
                       .domain(occExtent);
  const widthScale = d3.scaleLinear().domain(occExtent).range([1,3]);

  const linkG = svg.append('g').attr('class','links');
  linkG.selectAll('path')
    .data(valid)
    .enter().append('path')
      .attr('d', d => d3.line()
                        .x(p => p.x)
                        .y(p => p.y)
                        .curve(d3.curveBasis)(d.points))
      .attr('fill','none')
      .attr('stroke', d => colorScale(Number.isFinite(+d.edge_occurence) ? +d.edge_occurence : occExtent[0]))
      .attr('stroke-width', d => widthScale(Number.isFinite(+d.edge_occurence) ? +d.edge_occurence : occExtent[0]))
      .attr("stroke-dasharray", d => {const eo = +d.edge_occurence;return (Number.isFinite(eo) && eo === 0) ? "8,3,2,3" : null;})
      .attr('marker-end','url(#arrowhead)')
      .attr("class", d => {
        const eo = +d.edge_occurence;
        return `link ${Number.isFinite(eo) && eo === 0 ? "edge-zero" : "edge-nonzero"}`;
      })
      .attr("data-eo", d => Number.isFinite(+d.edge_occurence) ? +d.edge_occurence : "")
      .attr("data-src-base", d => KO_BASE(d._src))
      .attr("data-tgt-base", d => KO_BASE(d._tgt))
      .classed("bestpath-hit", d => {
        const s = KO_BASE(d._src);
        const t = KO_BASE(d._tgt);
        return bestSet && bestSet.has(s) && bestSet.has(t);
      })
      .on('mouseover', (evt,d) => {
        tooltip.transition().duration(200).style('opacity', 0.9);
        tooltip.html(`Edge Occurrence: ${Number.isFinite(+d.edge_occurence) ? d.edge_occurence : '—'}`)
               .style('left', `${evt.pageX + 5}px`)
               .style('top',  `${evt.pageY - 28}px`);
      })
      .on('mouseout', () => tooltip.transition().duration(500).style('opacity',0));
}

window.activeFlagMode = null;   // "below" | "out" | "both" | null

function highlightFlagNodes(mode){ // mode can be null
  const svg = d3.select("#graph-container svg");
  if (svg.empty()) return;

  svg.classed("flag-dim", !!mode);
  svg.classed("flag-dim-edges", !!mode);

  const nodes = svg.selectAll("g.nodes g.node");

  nodes.classed("flag-hit", function(d){
    if (!mode) return false;
    const isBelow = d?.flag_is_below_kofam_threshold === true;
    const isOut   = d?.is_outcompeted === true;

    if (mode === "below") return isBelow;
    if (mode === "out")   return isOut;
    if (mode === "both")  return isBelow && isOut;
    return false;
  });

  // bring highlighted nodes to front
  if (mode) nodes.filter(".flag-hit").raise();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.activeFlagMode = null;
    highlightFlagNodes(null);
    d3.select("#legend-overlay").selectAll(".legend-flag-row").classed("is-active", false);

    window.activeBestPath = false;
    highlightBestPathEdges(false);
    d3.select("#legend-overlay").selectAll(".legend-bestpath-row").classed("is-active", false);
  }
});

window.activeBestPath = false;

function highlightBestPathEdges(on) {
  const svg = d3.select("#graph-container svg");
  svg.classed("bestpath-dim", !!on);

  // bring best-path edges to front when highlighted
  if (on) {
    svg.selectAll("g.links path.bestpath-hit").raise();
  }
}


function addLegends(svg, SVG_W, { inLegendRow = false } = {}) {
  const legendX = inLegendRow ? 20 : (SVG_W - PAD_R + 20);
  const legendY = 20;


  const barW = 140;   // horizontal width
  const barH = 14;    // thin bar
  const spacingY = 36;

  const defs = svg.append("defs");

  // ===== SCALES (must match plotNodes) =====
  const dkScale = d3.scaleSequential()
    .domain([0, 1])
    .interpolator(d3.interpolateReds);

  const evScale = d3.scaleSequential()
    .domain([-50, 0])
    .interpolator(d3.interpolateRgb("#ff0000", "white"))
    .clamp(true);

  // ===== GRADIENTS =====
  defs.append("linearGradient")
    .attr("id", "dkGradientH")
    .attr("x1", "0%").attr("y1", "0%")
    .attr("x2", "100%").attr("y2", "0%")
    .call(g => {
      g.append("stop").attr("offset", "0%").attr("stop-color", dkScale(0));
      g.append("stop").attr("offset", "100%").attr("stop-color", dkScale(1));
    });

  defs.append("linearGradient")
    .attr("id", "evGradientH")
    .attr("x1", "0%").attr("y1", "0%")
    .attr("x2", "100%").attr("y2", "0%")
    .call(g => {
      g.append("stop").attr("offset", "0%").attr("stop-color", evScale(-50));
      g.append("stop").attr("offset", "100%").attr("stop-color", evScale(0));
    });

  const legend = svg.append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  legend.append("text")
    .attr("y", -6)
    .attr("font-size", 14)
    .attr("font-weight", 600)
    .text("Color Scales");

  // ===== Dk (confidence) =====
  const dkY = 10;

  legend.append("text")
    .attr("x", 0).attr("y", dkY - 2)
    .attr("font-size", 11)
    .text("Confidence");

  legend.append("rect")
    .attr("x", 0).attr("y", dkY)
    .attr("width", barW).attr("height", barH)
    .attr("fill", "url(#dkGradientH)");

  const dkAxis = d3.scaleLinear()
    .domain([0, 1])
    .range([0, barW]);

  legend.append("g")
    .attr("transform", `translate(0, ${dkY + barH})`)
    .call(d3.axisBottom(dkAxis).ticks(3))
    .selectAll("text").attr("font-size", 10);

  // ===== E-value =====
  const evY = dkY + barH + spacingY;

  legend.append("text")
    .attr("x", 0).attr("y", evY - 2)
    .attr("font-size", 11)
    .text("E-value (log10)");

  legend.append("rect")
    .attr("x", 0).attr("y", evY)
    .attr("width", barW).attr("height", barH)
    .attr("fill", "url(#evGradientH)");

  const evAxis = d3.scaleLinear()
    .domain([-50, 0])
    .range([0, barW]);

  legend.append("g")
    .attr("transform", `translate(0, ${evY + barH})`)
    .call(
      d3.axisBottom(evAxis)
        .tickValues([-50, -25, 0])
        .tickFormat(d => `1e${d}`)
    )
    .selectAll("text").attr("font-size", 10);


  // ===== FLAGS =====
  const flagsY = evY + barH + spacingY;

  legend.append("text")
    .attr("x", 0).attr("y", flagsY)
    .attr("font-size", 12)
    .attr("font-weight", 600)
    .text("Flags (hover to highlight)");

  const flagRows = [
    { sym: "!", label: "Below KOfam threshold", color: "#DD4400", mode: "below" },
    { sym: "?", label: "Outcompeted (not overlap winner)", color: "#ff7f50", mode: "out" },
    { sym: "x", label: "Both flags", color: "#DD4400", mode: "both" },
  ];

  flagRows.forEach((r, i) => {
  const rowY = flagsY + 16 + i * 18;

  const row = legend.append("g")
  .attr("class", "legend-flag-row")
  .style("cursor", "pointer")
  .style("pointer-events", "all");

  // hitbox so it feels like a button
  row.append("rect")
  .attr("class", "legend-hitbox")
  .attr("x", -6)
  .attr("y", rowY - 12)
  .attr("width", 260)
  .attr("height", 18)
  .attr("rx", 6)
  .attr("ry", 6)
  .attr("fill", "transparent")       
  .style("pointer-events", "all");  

  row.append("text")
    .attr("x", 0).attr("y", rowY)
    .attr("font-size", 14)
    .attr("font-weight", "bold")
    .attr("fill", r.color)
    .text(r.sym);

  row.append("text")
    .attr("x", 18).attr("y", rowY)
    .attr("font-size", 11)
    .attr("fill", "#333")
    .text(r.label);

  // --- behavior: hover previews unless something is locked ---
  row.on("mouseenter", () => {
      if (window.activeFlagMode) return;   // keep locked highlight
      highlightFlagNodes(r.mode);
    })
    .on("mouseleave", () => {
      if (window.activeFlagMode) return;
      highlightFlagNodes(null);
    })
    .on("click", () => {
      // toggle lock
      window.activeFlagMode = (window.activeFlagMode === r.mode) ? null : r.mode;
      highlightFlagNodes(window.activeFlagMode);

      // update visual active state in legend
      legend.selectAll(".legend-flag-row")
        .classed("is-active", d => false); // clear all (safe)

      // set active class on this row if locked
      row.classed("is-active", !!window.activeFlagMode && window.activeFlagMode === r.mode);
    });
});

    // ===== SIZE LEGEND =====
  const sizeY = flagsY + 16 + flagRows.length * 16 + 26;

  legend.append("text")
    .attr("x", 0).attr("y", sizeY)
    .attr("font-size", 12)
    .attr("font-weight", 600)
    .text("KO size (frequency in ATB Data)");

  const rScale = d3.scaleLinear().domain([0, 1]).range([5, 20]);
  const sizeVals = [0, 0.5, 1.0];

  const sx = 18;
  const sy = sizeY + 26;

  sizeVals.forEach((v, i) => {
    const r = rScale(v);

    const gx = sx + i * 75;

    legend.append("circle")
      .attr("cx", gx).attr("cy", sy)
      .attr("r", r)
      .attr("fill", "none")
      .attr("stroke", "#333");

    legend.append("text")
      .attr("x", gx).attr("y", sy + r + 18)
      .attr("text-anchor", "middle")
      .attr("font-size", 10)
      .attr("fill", "#333")
      .text(v);
  });

  // ===== EDGE LEGEND =====
  const edgeY = sy + 70;

  legend.append("text")
    .attr("x", 0).attr("y", edgeY)
    .attr("font-size", 12)
    .attr("font-weight", 600)
    .text("Edges (co-occurrence)");

  const edgeSamples = [
    { label: "occ > 0", dashed: false, w: 3 },
    { label: "occ = 0", dashed: true,  w: 2 },
  ];

  edgeSamples.forEach((e, i) => {
    const y = edgeY + 16 + i * 18;

    legend.append("line")
      .attr("x1", 0).attr("y1", y)
      .attr("x2", 60).attr("y2", y)
      .attr("stroke", "#666")
      .attr("stroke-width", e.w)
      .attr("stroke-dasharray", e.dashed ? "8,3,2,3" : null); // your distinct dash

    legend.append("text")
      .attr("x", 70).attr("y", y + 4)
      .attr("font-size", 11)
      .attr("fill", "#333")
      .text(e.label);
  });

  // ===== BEST PATH LEGEND =====
const bestY = edgeY + 16 + edgeSamples.length * 18 + 26;

legend.append("text")
  .attr("x", 0).attr("y", bestY)
  .attr("font-size", 12)
  .attr("font-weight", 600)
  .text("Best path (hover to highlight)");

const bestRowY = bestY + 18;

const bestRow = legend.append("g")
  .attr("class", "legend-bestpath-row")
  .style("cursor", "pointer")
  .style("pointer-events", "all")
  .on("mouseenter", () => {
    if (window.activeBestPath) return;   // keep locked highlight
    highlightBestPathEdges(true);
  })
  .on("mouseleave", () => {
    if (window.activeBestPath) return;
    highlightBestPathEdges(false);
  })
  .on("click", () => {
    window.activeBestPath = !window.activeBestPath;
    highlightBestPathEdges(window.activeBestPath);
    bestRow.classed("is-active", window.activeBestPath);
  });

bestRow.append("rect")
  .attr("x", -6).attr("y", bestRowY - 12)
  .attr("width", 260).attr("height", 18)
  .attr("rx", 6).attr("ry", 6)
  .attr("fill", "transparent")
  .style("pointer-events", "all");

bestRow.append("line")
  .attr("x1", 0).attr("y1", bestRowY)
  .attr("x2", 60).attr("y2", bestRowY)
  .attr("stroke", "#d11")
  .attr("stroke-width", 4);

bestRow.append("text")
  .attr("x", 70).attr("y", bestRowY + 4)
  .attr("font-size", 11)
  .attr("fill", "#333")
  .text("Highlight edges between best-path KOs");
}

  

function makePanelDraggable(panel, handleSelector = '.influence-header') {
  const handle = panel.querySelector(handleSelector) || panel;

  let isDragging = false;
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0;

  handle.addEventListener('mousedown', (e) => {
    // avoid dragging when clicking the close button etc.
    if (e.target.closest('button')) return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    const rect = panel.getBoundingClientRect();

    // Convert current position to left/top (in case you started with right:)
    panel.style.left = rect.left + 'px';
    panel.style.top  = rect.top  + 'px';
    panel.style.right = 'auto';   // stop being anchored by "right"
    panel.style.bottom = 'auto';

    startLeft = rect.left;
    startTop  = rect.top;

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!isDragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    panel.style.left = (startLeft + dx) + 'px';
    panel.style.top  = (startTop  + dy) + 'px';
  }

  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

function buildModuleToCategoryMap(meta) {
  const map = new Map();
  if (!meta) return map;

  for (const [category, modules] of Object.entries(meta)) {
    for (const mid of Object.keys(modules)) {
      map.set(mid, category);
    }
  }
  return map;
}


function renderInfluencePanelForSink(sinkArg) {
  // helpers
  const sinkBase = KO_BASE(typeof sinkArg === 'object' ? NODE_ID(sinkArg) : sinkArg);


const currentModuleId = window.currentModuleId;
const rawModule = window.currentModuleJson || {};

let moduleBlock = null;

if (rawModule) {
  if ('module_equation' in rawModule || 'module_probability_before' in rawModule) {
    moduleBlock = rawModule;
  } else if (currentModuleId && rawModule[currentModuleId]) {
    moduleBlock = rawModule[currentModuleId];
  }
}

const moduleKOs = new Set();
if (moduleBlock && Array.isArray(moduleBlock.nodes)) {
  for (const n of moduleBlock.nodes) {
    const ko = KO_BASE(NODE_ID(n));
    if (ko && ko !== "START" && ko !== "SINK") {
      moduleKOs.add(ko);
    }
  }
}

  // reuse the exact datum you drew in the main graph
  const getNodeDatum = (baseKO) => {
  const key = KO_BASE(String(baseKO ?? "").replace(/^ko:/i, "").trim());


  // First: what is currently drawn (fast + includes step/layout fields)
  if (window.nodeByBase && typeof window.nodeByBase.get === "function") {
    const arr = window.nodeByBase.get(key);
    if (arr && arr.length) return arr[0];   // or pick best one

  }

  // Second: full node set (all KOs in uploaded JSON)
  if (window.koIndex && typeof window.koIndex.get === "function") {
    const hit = window.koIndex.get(key);
    if (hit) return hit;
  }

  // Last fallback
  return (currentNodes || []).find(nn => KO_BASE(NODE_ID(nn)) === key) || {};
};


  // reuse shared scales if available; otherwise create safe fallbacks
  const dkScale = (window.sharedScales && window.sharedScales.dkScale)
    ? window.sharedScales.dkScale
    : d3.scaleSequential(d3.interpolateReds).domain([0, 1]);

  const evScale = (window.sharedScales && window.sharedScales.evScale)
    ? window.sharedScales.evScale
    : d3.scaleSequential()
        .domain([-50, 0]) // log10(E)
        .interpolator(d3.interpolateRgb("#ff0000", "white"))
        .clamp(true);

  // draw split node identical to main graph: top=Dk_(before/after), bottom=E-value
  function drawSplitCircle(g, nodeDatum, r) {
    //const dkVal  = window.useDkAfter ? nodeDatum?.Dk_Neighbor : nodeDatum?.Dk;
    const dkVal = nodeDatum?.Dk_Neighbor;

    const evVal  = +nodeDatum?.["E-value"];
    const dkFill = (dkVal == null) ? "#cccccc" : dkScale(dkVal);
    const evFill = Number.isFinite(Math.log10(evVal)) ? evScale(Math.log10(evVal)) : "#888888";

    g.append('path')
      .attr('d', d3.arc().innerRadius(0).outerRadius(r)({startAngle:-Math.PI/2, endAngle: Math.PI/2}))
      .attr('fill', dkFill);

    g.append('path')
      .attr('d', d3.arc().innerRadius(0).outerRadius(r)({startAngle: Math.PI/2, endAngle:  3*Math.PI/2}))
      .attr('fill', evFill);

    g.append('line').attr('x1', -r).attr('y1', 0).attr('x2', r).attr('y2', 0).attr('stroke', 'black').attr('stroke-width', 1);
    g.append('circle').attr('r', r).attr('fill', 'none').attr('stroke', 'black').attr('stroke-width', 1);
  }

  // data
  const sinkDatum = getNodeDatum(sinkBase);
  const sinkModules = Array.isArray(sinkDatum?.modules_present) ? sinkDatum.modules_present : [];
  const sinkModuleCount = sinkModules.length;


  const bs = sinkDatum?.buddy_stats || null;
  let incoming = Array.isArray(bs?.buddies) ? bs.buddies : [];

  // sort strongest first (by buddy weight)
  incoming.sort((a, b) => {
  const cA = (a.contrib == null || !isFinite(+a.contrib)) ? -Infinity : +a.contrib;
  const cB = (b.contrib == null || !isFinite(+b.contrib)) ? -Infinity : +b.contrib;
  if (cB !== cA) return cB - cA;

  const wA = (a.weight == null || !isFinite(+a.weight)) ? -Infinity : +a.weight;
  const wB = (b.weight == null || !isFinite(+b.weight)) ? -Infinity : +b.weight;
  return wB - wA;
});
  
  const fmtE = v => {
    if (v == null || !isFinite(+v)) return "—";
    if (+v === 100.0) return "NA";          
    return v < 1e-3 ? (+v).toExponential(2) : (+v).toFixed(4);
  };

  const sinkEv = +sinkDatum?.["E-value"];
  const sinkDk  = sinkDatum?.Dk;
  const sinkDkP = sinkDatum?.Dk_Neighbor;
  const sinkShift = sinkDatum?.buddy_stats?.shift;

let neighborRows = incoming.map(b => {
  const srcKO  = KO_BASE(String(b.ko ?? "").replace(/^ko:/i, "").trim());
  console.log("koIndex size:", window.koIndex?.size);
  console.log("incoming example raw:", incoming[0]?.ko, "normalized:", KO_BASE(String(incoming[0]?.ko ?? "").replace(/^ko:/i,"").trim()));


  const nDatum = getNodeDatum(srcKO);
  const corr = (Number.isFinite(b.Nij) && Number.isFinite(b.Nj) && b.Nj !== 0) ? (b.Nij / b.Nj) : null;

  return {
    ko: srcKO,
    Nij: b.Nij,
    Nj: b.Nj,
    corr,
    Rij: b.Rij,
    w: b.weight,
    pj: b.pj,
    contrib: b.contrib,
    dk: nDatum?.Dk,
    dkP: nDatum?.Dk_Neighbor,
    sameModule: moduleKOs.has(srcKO)
  };
});



neighborRows.sort((a, b) => {
  const cA = (a.contrib == null || !isFinite(+a.contrib)) ? -Infinity : +a.contrib;
  const cB = (b.contrib == null || !isFinite(+b.contrib)) ? -Infinity : +b.contrib;
  if (cB !== cA) return cB - cA;

  const wA = (a.w == null || !isFinite(+a.w)) ? -Infinity : +a.w;
  const wB = (b.w == null || !isFinite(+b.w)) ? -Infinity : +b.w;
  return wB - wA;
});

  //  panel skeleton 
  const tableHTML = `
  <table style="width:100%; border-collapse:collapse; margin-top:8px; font-size:12px;">
    <thead>
      <tr>
        <th style="text-align:left;  border-bottom:1px solid #ddd; padding:4px 6px;">Influencing KO</th>
        <th style="text-align:left; border-bottom:1px solid #ddd; padding:4px 6px;">Module</th>
        <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">N<sub>ij</sub></th>
        <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">N<sub>j</sub></th>
        <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">Corr</th>
        <!-- <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">R<sub>ij</sub></th> -->
        <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">weight</th>
        <!-- <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">P<sub>j</sub></th> -->
        <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">P<sub>i</sub></th>
        <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">contrib</th>
        <!-- <th style="text-align:right; border-bottom:1px solid #ddd; padding:4px 6px;">C<sub>i</sub></th> -->
      </tr>
    </thead>
    <tbody>
      ${neighborRows.map(r => `
            <tr style="${r.sameModule ? "background: rgba(76,175,80,0.12);" : ""}">
    <td style="padding:4px 6px; border-bottom:1px solid #f0f0f0;">
      <a href="${keggKoLink(r.ko)}" target="_blank" rel="noopener noreferrer" style="color:#4f86c1; text-decoration:underline;">${r.ko}</a>
    </td>
    <td style="padding:4px 6px; border-bottom:1px solid #f0f0f0;">
      ${r.sameModule ? "<span style='font-weight:600;'>same</span>" : "<span style='color:#777;'>other</span>"}
    </td>
    <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${r.Nij ?? "—"}</td>
          <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${r.Nj ?? "—"}</td>
          <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">
  ${(r.corr == null || !isFinite(+r.corr)) ? "—" : (+r.corr).toFixed(3)}
</td>

          <!-- <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${(r.Rij == null || !isFinite(+r.Rij)) ? "—" : (+r.Rij).toFixed(3)}</td> -->
          <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${fmtP3(r.w)}</td>
          <!-- <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${(r.pj == null || !isFinite(+r.pj)) ? "—" : (+r.pj).toPrecision(3)}</td> -->
          <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${fmtP3(r.dk)}</td>
          <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${(r.contrib == null || !isFinite(+r.contrib)) ? "—" : (+r.contrib).toPrecision(3)}</td>
          <!-- <td style="padding:4px 6px; text-align:right; border-bottom:1px solid #f0f0f0;">${fmtP3(r.dkP)}</td> -->
        </tr>
      `).join("")}
    </tbody>
  </table>
`;


const panel = document.getElementById("influence-panel");
panel.style.display = "block";
panel.innerHTML = `
  <div class="influence-header"
       style="display:flex; align-items:center; justify-content:space-between; gap:8px; cursor:move;">
    <h3 style="margin:0;">Influence → <code>${sinkBase}</code></h3>
    <button
      id="influence-close-btn"
      style="
        border:none;
        background:#eee;
        border-radius:999px;
        width:24px;
        height:24px;
        cursor:pointer;
        font-weight:bold;
        line-height:1;
        padding:0;
      "
      title="Close"
    >×</button>
  </div>

  <div class="meta" style="margin-top:4px;">
  <strong>E-value:</strong> ${fmtE(sinkEv)}<br>
  &nbsp;•&nbsp;<strong>P<sub>i</sub>:</strong> ${fmtP3(sinkDk)}
  <strong>+ shift:</strong> ${fmtP3(sinkShift)}
  <strong> = C<sub>i</sub> = </strong> ${fmtP3(sinkDkP)}<br>
  &nbsp;•&nbsp;<strong>Valid influencers:</strong> ${incoming.length}<br>
  &nbsp;•&nbsp;<strong>Modules:</strong> ${
    sinkModules.length
      ? sinkModules.map(m => `<a href="https://www.kegg.jp/entry/${m}" target="_blank" rel="noopener noreferrer" style="color:#4f86c1; text-decoration:underline;">${m}</a>`).join(", ")
      : "—"
  }
  </div>

  <svg id="influence-svg" viewBox="0 0 360 280" preserveAspectRatio="xMidYMid meet"></svg>
  ${tableHTML}
`;


  // wire up close button
  const closeBtn = document.getElementById("influence-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      panel.style.display = "none";
    });
  }

  // make the panel draggable (re-applies each time content is replaced)
  makePanelDraggable(panel);


  const svg = d3.select("#influence-svg");
  svg.selectAll("*").remove();

  const w = 360, h = 280, cx = w/2, cy = h/2;
  const radius = Math.min(w, h) / 2 - 34;

  // arrow marker
const defs = svg.append("defs");
defs.append("marker")
  .attr("id", "mini-arrow")
  .attr("viewBox", "-0 -5 10 10")
  .attr("refX", 0)
  .attr("refY", 0)
  .attr("orient", "auto")
  .attr("markerUnits", "strokeWidth")   
  .attr("markerWidth", 5)
  .attr("markerHeight", 5)
  .append("path")
    .attr("d", "M 0,-5 L 10,0 L 0,5")
    .attr("fill", "currentColor");      

const maxW = incoming.length ? d3.max(incoming, d => +d.weight || 0) : 1;

const sw = d3.scaleLinear().domain([0, maxW || 1]).range([1, 3]); 


  // draw sources ring 
  const N = Math.max(1, incoming.length);
  incoming.forEach((b, i) => {
    const ang = (2 * Math.PI * i) / N - Math.PI/2;
    const x = cx + radius * Math.cos(ang);
    const y = cy + radius * Math.sin(ang);

    const x1 = x;
    const y1 = y;
    const x2 = cx;
    const y2 = cy;

    // explicit midpoint vertex (this is where marker-mid will go)
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    svg.append("path")
      .attr("d", `M ${x1} ${y1} L ${mx} ${my} L ${x2} ${y2}`)
      .attr("fill", "none")
      .attr("stroke", "#555")
      .attr("stroke-opacity", 0.9)
      .attr("stroke-width", sw(+b.weight || 0))
      .attr("marker-mid", "url(#mini-arrow)")
      .attr("stroke-dasharray", null);

    const srcKO = KO_BASE(b.ko);
    const srcDatum = getNodeDatum(srcKO);
    const g = svg.append("g").attr("transform", `translate(${x},${y})`);
    drawSplitCircle(g, srcDatum, 7);

    g.append("circle")
    .attr("r", 10)
    .attr("fill", "none")
    .attr("stroke", moduleKOs.has(srcKO) ? "#68BB59" : "white")
    .attr("stroke-width", 2);

    svg.append("text")
      .attr("x", x).attr("y", y - 12)
      .attr("text-anchor", "middle").style("font-size", "10px")
      .text(srcKO);
  });


  // center sink
  const gSink = svg.append("g").attr("transform", `translate(${cx},${cy})`);
  drawSplitCircle(gSink, sinkDatum, 10);

  svg.append("text")
    .attr("x", cx).attr("y", cy + 24)
    .attr("text-anchor", "middle").style("font-weight", "600")
    .text(sinkBase);
}



function renderModuleSummary(rawModuleData, moduleId) {
  const container = d3.select('#stats-table-container').html('');
  const cleanId = String(moduleId).trim();

  // --- Resolve the module block from whatever I got ---
  let moduleData = null;

  if (rawModuleData) {
    // Case 1: rawModuleData is already a single module block
    if ('module_probability_before' in rawModuleData ||
        'module_equation' in rawModuleData) {
      moduleData = rawModuleData;
    }
    // Case 2: rawModuleData is a map: { M00043: {...}, M00044: {...}, ... }
    else if (rawModuleData[cleanId]) {
      moduleData = rawModuleData[cleanId];
    }
  }

  if (!moduleData) {
    container.text(`No data for module ${cleanId}`);
    return;
  }

  const before = moduleData.module_probability_before;
  const after  = moduleData.module_probability_after;
  //const eqn    = moduleData.module_equation;
  // Build KO rows from currentNodes for this module 
  let koRows = (currentNodes || []).filter(n => {
    const base = KO_BASE(NODE_ID(n));
    if (base === "START" || base === "SINK") return false;

    const mods = n.Modules;
    if (!mods) return false;

    return mods
      .split(',')
      .map(s => s.trim())
      .includes(cleanId);
  });


  if ((!koRows || koRows.length === 0) && currentNodes && currentNodes.length) {
  koRows = currentNodes.filter(n => {
    const base = KO_BASE(NODE_ID(n));
    return base !== "START" && base !== "SINK";
  });
}


  const koTableHTML = `
    <table style="width:100%; border-collapse:collapse; margin-top:10px; font-size:13px;">
      <thead>
        <tr style="background:#eee;">
          <th style="padding:4px 6px; border-bottom:1px solid #ccc;">KO id</th>
          <th style="padding:4px 6px; border-bottom:1px solid #ccc;">Target name</th>
          <th style="padding:4px 6px; border-bottom:1px solid #ccc;">E-value</th>
          <th style="padding:4px 6px; border-bottom:1px solid #ccc;">Score</th>
          <th style="padding:4px 6px; border-bottom:1px solid #ccc;">Overlap_Group_Winner</th>
          <th style="padding:4px 6px; border-bottom:1px solid #ccc;">Overlap_Group_Winner_Score</th>
        </tr>
      </thead>
      <tbody>
        ${koRows.map(n => {
  const base  = KO_BASE(NODE_ID(n));              // KO id shown in first column
  const ev    = n["E-value"];
  const score = n.score ?? n["score"];

  const ogwRaw = normStr(n.overlapgroup_winner, "");
  const ogws   = normNum(n.overlapgroup_winner_score, null);

  // normalize both so "K01234", " K01234 ", etc compare cleanly
  const baseNorm = String(base ?? "").trim();
  const ogwNorm  = String(ogwRaw ?? "").trim();

  // show winner only if it's non-empty and not equal to KO id
  const showOGW = ogwNorm && ogwNorm !== baseNorm;

  return `
    <tr>
      <td style="padding:4px 6px; border-bottom:1px solid #eee;">${baseNorm || "—"}</td>
      <td style="padding:4px 6px; border-bottom:1px solid #eee;">${normStr(n["target name"], "—")}</td>
      <td style="padding:4px 6px; border-bottom:1px solid #eee;">${fmtE(ev)}</td>
      <td style="padding:4px 6px; border-bottom:1px solid #eee;">${score == null ? "—" : score}</td>
      <td style="padding:4px 6px; border-bottom:1px solid #eee;">${showOGW ? ogwNorm : "—"}</td>
      <td style="padding:4px 6px; border-bottom:1px solid #eee;">${showOGW && ogws != null ? ogws : "—"}</td>
    </tr>
  `;
}).join("")}

      </tbody>
    </table>
  `;

  container.html(`
    <div style="padding:10px 14px; border:1px solid #ccc; border-radius:8px; background:#fafafa; margin:10px auto; max-width:1200px;">
      <h3 style="margin-top:0;">Summary for ${cleanId} Module</h3>
      <p><strong>Confidence (Raw):</strong> ${fmtP3(before)}</p>
      <p><strong>Confidence (After Influencer Propagation):</strong> ${fmtP3(after)}</p>

      <h4 style="margin-top:1rem;">KOs in this module</h4>
      ${koTableHTML}
    </div>
  `);
}
