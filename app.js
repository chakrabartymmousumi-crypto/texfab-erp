// ============================================================
//  app.js  — Inventory Master  |  Firebase Firestore + Auth
//  All data is real, saved to Firestore, synced live to all users
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, getDoc,
  where, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Theme toggle — dark / light ───────────────────────────────
(function applyThemeOnLoad() {
  const saved = localStorage.getItem('im-theme');
  if (saved === 'light') document.body.classList.add('light');
})();

window.toggleTheme = function() {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('im-theme', isLight ? 'light' : 'dark');
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── Globals ──────────────────────────────────────────────────
let currentUser   = null;
let currentRole   = null;
let activePanel   = 'dashboard';
let unsubs        = [];   // unsubscribe Firestore listeners on panel change

// ── Auth guard ───────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (!snap.exists()) { await signOut(auth); return; }
  currentUser = { uid: user.uid, ...snap.data() };
  currentRole = currentUser.role;
  renderUserChip();
  applyRolePermissions();
  navTo('dashboard');
  setupRealtimeDashboard();
});

// ── Logout ───────────────────────────────────────────────────
window.doLogout = async () => {
  await signOut(auth);
  window.location.href = 'index.html';
};

// ── Toast ────────────────────────────────────────────────────
window.toast = (msg, type = 'success') => {
  const el = document.createElement('div');
  el.className = `toast-msg ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

// ── Render user chip ─────────────────────────────────────────
function renderUserChip() {
  document.getElementById('user-name').textContent = currentUser.name || currentUser.email;
  document.getElementById('user-role').textContent = currentRole;
  document.getElementById('user-initials').textContent =
    (currentUser.name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
}

// ── Role Permissions ─────────────────────────────────────────
const ROLE_PERMISSIONS = {
  admin:     ['dashboard','material','supplier','processor','jobworker','customer','purchase','stock','transfer','dyeing','lamination','jobwork','reports','users'],
  store:     ['dashboard','material','stock','transfer'],
  purchase:  ['dashboard','purchase','supplier','stock'],
  production:['dashboard','stock','transfer','dyeing','lamination','jobwork'],
  dyeing:    ['dashboard','dyeing','transfer'],
  lamination:['dashboard','lamination','transfer'],
  accounts:  ['dashboard','reports','purchase','stock'],
  jobcoord:  ['dashboard','jobwork','transfer'],
};
function applyRolePermissions() {
  const allowed = ROLE_PERMISSIONS[currentRole] || ['dashboard'];
  document.querySelectorAll('.nav-item[data-panel]').forEach(el => {
    const p = el.dataset.panel;
    el.style.display = allowed.includes(p) ? '' : 'none';
  });
}

// ── Navigation ───────────────────────────────────────────────
window.navTo = (id) => {
  // unsubscribe old listeners
  unsubs.forEach(u => u());
  unsubs = [];

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const panel = document.getElementById('p-' + id);
  if (!panel) return;
  panel.classList.add('active');
  document.querySelector(`.nav-item[data-panel="${id}"]`)?.classList.add('active');
  document.getElementById('ptitle').textContent = PAGE_TITLES[id] || id;
  document.querySelector('.content').scrollTop = 0;
  activePanel = id;

  // Load data for the panel
  const loaders = {
    dashboard:   setupRealtimeDashboard,
    material:    loadMaterials,
    supplier:    loadSuppliers,
    processor:   loadProcessors,
    jobworker:   loadJobWorkers,
    customer:    loadCustomers,
    purchase:    loadPurchaseOrders,
    stock:       loadStock,
    transfer:    loadTransfers,
    dyeing:      loadDyeingOrders,
    lamination:  loadLaminationOrders,
    jobwork:     loadJobWork,
    reports:     () => {},
    users:       loadUsers,
  };
  loaders[id]?.();
};

const PAGE_TITLES = {
  dashboard:'Dashboard',material:'Material Master',supplier:'Supplier Master',
  processor:'Processor Master',jobworker:'Job Worker Master',customer:'Customer Master',
  purchase:'Purchase Management',stock:'Stock Management',transfer:'Material Transfer',
  dyeing:'Dyeing Orders',lamination:'Lamination Orders',jobwork:'Job Work Management',
  reports:'Reports & Analytics',users:'User Management',
};

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tabs').forEach(tb => {
  tb.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', function() {
      tb.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      this.classList.add('active');
    });
  });
});

// ── Helpers ───────────────────────────────────────────────────
const fmtDate = (ts) => {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
};
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const el  = id => document.getElementById(id);

// ── Modal helpers ─────────────────────────────────────────────
window.openModal = (id) => el(id).classList.remove('hidden');
window.closeModal = (id) => { el(id).classList.add('hidden'); };
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

// ══════════════════════════════════════════════════════════════
//  DASHBOARD  — real-time KPI aggregation from ALL collections
// ══════════════════════════════════════════════════════════════
function setupRealtimeDashboard() {

  // ── 1. Materials — low stock + total count ─────────────────
  const unsubMat = onSnapshot(collection(db, 'materials'), snap => {
    let low = 0, totalMat = 0;
    let totalStockKg = 0;
    snap.forEach(d => {
      const m = d.data();
      totalMat++;
      totalStockKg += Number(m.currentStock || 0);
      if (Number(m.currentStock||0) < Number(m.reorderLevel||0) && Number(m.reorderLevel||0) > 0) low++;
    });
    safeSet('kpi-lowstock', low);
    safeSet('kpi-total-mat', totalMat);
    safeSet('kpi-factory', fmtNum(totalStockKg) + ' kg');
    renderLowStockAlerts(snap);
  });
  unsubs.push(unsubMat);

  // ── 2. Purchase Orders — open count ───────────────────────
  const unsubPO = onSnapshot(
    query(collection(db,'purchase_orders'), where('status','in',['draft','sent','partial'])),
    snap => safeSet('kpi-pending-po', snap.size)
  );
  unsubs.push(unsubPO);

  // ── 3. Dyeing Orders — pending count + kg at dyeing ───────
  const unsubDy = onSnapshot(collection(db,'dyeing_orders'), snap => {
    let pending = 0, overdue = 0, dyeingKg = 0;
    const now = new Date();
    snap.forEach(d => {
      const o = d.data();
      if (o.status === 'processing') {
        pending++;
        dyeingKg += Number(o.inputQty || 0) - Number(o.receivedQty || 0);
        if (o.expectedDate && new Date(o.expectedDate) < now) overdue++;
      }
    });
    safeSet('kpi-dyeing', fmtNum(dyeingKg) + ' kg');
    safeSet('kpi-dy-pending', pending);
    safeSet('kpi-overdue', (el('kpi-overdue') ? Number(el('kpi-overdue').textContent||0) : 0) + overdue);
  });
  unsubs.push(unsubDy);

  // ── 4. Lamination Orders — pending count + kg at lam ──────
  const unsubLm = onSnapshot(collection(db,'lamination_orders'), snap => {
    let pending = 0, overdue = 0, lamKg = 0;
    const now = new Date();
    snap.forEach(d => {
      const o = d.data();
      if (o.status === 'processing') {
        pending++;
        lamKg += Number(o.inputQty || 0) - Number(o.receivedQty || 0);
        if (o.expectedDate && new Date(o.expectedDate) < now) overdue++;
      }
    });
    safeSet('kpi-lam', fmtNum(lamKg) + ' kg');
    safeSet('kpi-lm-pending', pending);
  });
  unsubs.push(unsubLm);

  // ── 5. Job Work — pending count + kg at workers ───────────
  const unsubJW = onSnapshot(collection(db,'job_work'), snap => {
    let pending = 0, overdue = 0, jwKg = 0;
    const now = new Date();
    snap.forEach(d => {
      const o = d.data();
      if (o.status === 'issued') {
        pending++;
        jwKg += Number(o.issuedQty || 0) - Number(o.receivedQty || 0);
        if (o.dueDate && new Date(o.dueDate) < now) overdue++;
      }
    });
    safeSet('kpi-jw', fmtNum(jwKg) + ' kg');
    safeSet('kpi-jwork-pending', pending);
  });
  unsubs.push(unsubJW);

  // ── 6. Transfers — processor pending map ──────────────────
  const unsubProc = onSnapshot(collection(db,'transfers'), snap => {
    const map = {};
    snap.forEach(d => {
      const t = d.data();
      if (!['sent','in_process','partial'].includes(t.status)) return;
      const key = t.toLocation || 'Unknown';
      map[key] = (map[key]||0) + Number(t.sentQty||0);
    });
    renderProcessorPending(map);
  });
  unsubs.push(unsubProc);

  // ── 7. Today's transactions ────────────────────────────────
  const unsubTxn = onSnapshot(
    query(collection(db,'transactions'), orderBy('createdAt','desc')),
    snap => {
      const today = new Date().toDateString();
      let todayCount = 0;
      const rows = [];
      snap.forEach(d => {
        const r = d.data();
        if (rows.length < 8) rows.push({ id: d.id, ...r });
        if (r.createdAt) {
          const dt = r.createdAt.toDate ? r.createdAt.toDate() : new Date(r.createdAt);
          if (dt.toDateString() === today) todayCount++;
        }
      });
      safeSet('kpi-today-txn', todayCount);
      renderRecentTransactions(rows);
    }
  );
  unsubs.push(unsubTxn);

  // ── 8. Stock ledger for location bars ─────────────────────
  const unsubStock = onSnapshot(collection(db, 'stock'), snap => {
    let factory=0, dyeingS=0, lamS=0, jwS=0, transit=0;
    snap.forEach(d => {
      const s = d.data();
      const loc = (s.location || '').toLowerCase();
      const bal = Number(s.balance || 0);
      if (loc.includes('factory') || loc.includes('warehouse')) factory += bal;
      else if (loc.includes('dye')) dyeingS += bal;
      else if (loc.includes('lam')) lamS += bal;
      else if (loc.includes('job') || loc.includes('worker')) jwS += bal;
      else if (loc.includes('transit')) transit += bal;
    });
    renderLocationBars({ factory, dyeing:dyeingS, lam:lamS, jw:jwS, transit });
  });
  unsubs.push(unsubStock);
}

function safeSet(id, val) {
  const e = el(id); if (e) e.textContent = val;
}

function renderLocationBars(data) {
  const container = el('location-bars');
  if (!container) return;
  const max = Math.max(...Object.values(data), 1);
  const entries = [
    { label:'Factory / Warehouses', val:data.factory, color:'var(--green)' },
    { label:'Dyeing Houses', val:data.dyeing, color:'var(--purple)' },
    { label:'Lamination Houses', val:data.lam, color:'var(--amber)' },
    { label:'Job Workers', val:data.jw, color:'var(--coral,#ff7a5c)' },
    { label:'In Transit', val:data.transit, color:'var(--text-muted)' },
  ];
  container.innerHTML = entries.map(e => `
    <div class="bar-row">
      <div class="bar-label">${e.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(e.val/max*100)}%;background:${e.color}"></div></div>
      <div class="bar-val" style="color:${e.color}">${fmtNum(e.val)} kg</div>
    </div>`).join('');
}

function renderLowStockAlerts(snap) {
  const container = el('alert-list');
  if (!container) return;
  const alerts = [];
  snap.forEach(d => {
    const m = d.data();
    if (Number(m.currentStock||0) < Number(m.reorderLevel||0)) {
      alerts.push(`<div class="alert-item a-warn"><i class="ti ti-alert-triangle"></i>
        <span>${m.name} — stock ${fmtNum(m.currentStock)} ${m.unit||'kg'}, reorder level ${fmtNum(m.reorderLevel)} ${m.unit||'kg'}</span></div>`);
    }
  });
  if (!alerts.length) container.innerHTML = '<div class="alert-item a-success"><i class="ti ti-check"></i><span>No low stock alerts. All materials above reorder level.</span></div>';
  else container.innerHTML = alerts.join('');
}

function renderRecentTransactions(rows) {
  const tbody = el('recent-txn-body');
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty"><i class="ti ti-database-off"></i><p>No transactions yet</p></td></tr>`; return; }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="c-muted">${fmtDate(r.createdAt)}</td>
      <td>${typePill(r.type)}</td>
      <td class="fw5">${r.material||'—'}</td>
      <td class="mono">${fmtNum(r.qty)} ${r.unit||'kg'}</td>
      <td>${statusPill(r.status)}</td>
    </tr>`).join('');
}

function renderProcessorPending(map) {
  const tbody = el('proc-pending-body');
  if (!tbody) return;
  const keys = Object.keys(map);
  if (!keys.length) { tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-muted);padding:20px;text-align:center">No pending material at processors</td></tr>`; return; }
  tbody.innerHTML = keys.map(k => `
    <tr>
      <td class="fw5">${k}</td>
      <td class="mono c-amber">${fmtNum(map[k])} kg</td>
      <td><span class="pill p-amber">Pending</span></td>
    </tr>`).join('');
}

// ══════════════════════════════════════════════════════════════
//  MATERIAL MASTER
// ══════════════════════════════════════════════════════════════
function loadMaterials() {
  const unsub = onSnapshot(
    query(collection(db,'materials'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('mat-tbody');
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = emptyRow(11, 'No materials added yet'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const m = d.data(); const id = d.id;
        const low = Number(m.currentStock||0) < Number(m.reorderLevel||0);
        return `<tr>
          <td class="mono c-muted">${m.code||'—'}</td>
          <td class="fw5">${m.name||'—'}</td>
          <td>${m.category||'—'}</td>
          <td>${m.gsm||'—'}</td>
          <td>${m.width||'—'}</td>
          <td>${m.unit||'Kg'}</td>
          <td class="mono ${low?'c-red fw5':'c-green fw5'}">${fmtNum(m.currentStock)} ${m.unit||'kg'}</td>
          <td class="mono">${fmtNum(m.reorderLevel)}</td>
          <td>${m.gstRate||'—'}</td>
          <td>${low ? '<span class="pill p-red">Low Stock</span>' : '<span class="pill p-green">Active</span>'}</td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="editMaterial('${id}')">Edit</button>
            ${canDelete() ? `<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteMaterial('${id}')">Del</button>` : ''}
          </td>
        </tr>`;
      }).join('');
    }
  );
  unsubs.push(unsub);
}

window.openAddMaterial = () => {
  el('mat-form').reset();
  el('mat-form-id').value = '';
  el('mat-modal-title').textContent = 'Add Material';
  openModal('mat-modal');
};
window.editMaterial = async (id) => {
  const snap = await getDoc(doc(db,'materials',id));
  if (!snap.exists()) return;
  const m = snap.data();
  const f = el('mat-form');
  f.matCode.value = m.code||'';
  f.matName.value = m.name||'';
  f.matCategory.value = m.category||'';
  f.matGsm.value = m.gsm||'';
  f.matWidth.value = m.width||'';
  f.matUnit.value = m.unit||'Kg';
  f.matStock.value = m.currentStock||0;
  f.matReorder.value = m.reorderLevel||0;
  f.matHsn.value = m.hsn||'';
  f.matGst.value = m.gstRate||'';
  f.matCost.value = m.stdCost||'';
  el('mat-form-id').value = id;
  el('mat-modal-title').textContent = 'Edit Material';
  openModal('mat-modal');
};
window.saveMaterial = async () => {
  const f = el('mat-form');
  const id = el('mat-form-id').value;
  const data = {
    code:f.matCode.value.trim(), name:f.matName.value.trim(),
    category:f.matCategory.value.trim(), gsm:f.matGsm.value,
    width:f.matWidth.value, unit:f.matUnit.value,
    currentStock:Number(f.matStock.value)||0,
    reorderLevel:Number(f.matReorder.value)||0,
    hsn:f.matHsn.value, gstRate:f.matGst.value,
    stdCost:Number(f.matCost.value)||0,
    updatedAt:serverTimestamp(),
  };
  if (!data.name) { toast('Material name is required','error'); return; }
  try {
    if (id) { await updateDoc(doc(db,'materials',id), data); toast('Material updated'); }
    else { data.createdAt = serverTimestamp(); await addDoc(collection(db,'materials'), data); toast('Material added'); }
    closeModal('mat-modal');
  } catch(e) { toast(e.message,'error'); }
};
window.deleteMaterial = async (id) => {
  if (!confirm('Delete this material?')) return;
  await deleteDoc(doc(db,'materials',id));
  toast('Material deleted');
};

// ══════════════════════════════════════════════════════════════
//  SUPPLIER MASTER
// ══════════════════════════════════════════════════════════════
function loadSuppliers() {
  const unsub = onSnapshot(
    query(collection(db,'suppliers'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('sup-tbody');
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = emptyRow(8,'No suppliers added yet'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const s = d.data();
        return `<tr>
          <td class="mono c-muted">${s.code||'—'}</td>
          <td class="fw5">${s.name||'—'}</td>
          <td class="mono">${s.gst||'—'}</td>
          <td>${s.contact||'—'}</td>
          <td class="mono">${s.phone||'—'}</td>
          <td>${s.paymentTerms||'—'}</td>
          <td><span class="pill ${s.status==='active'?'p-green':'p-amber'}">${s.status||'active'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="editSupplier('${d.id}')">Edit</button>
            ${canDelete()?`<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteSupplier('${d.id}')">Del</button>`:''}
          </td>
        </tr>`;
      }).join('');
    }
  );
  unsubs.push(unsub);
}
window.openAddSupplier = () => { el('sup-form').reset(); el('sup-form-id').value=''; openModal('sup-modal'); };
window.editSupplier = async (id) => {
  const snap = await getDoc(doc(db,'suppliers',id));
  if (!snap.exists()) return;
  const s = snap.data(); const f = el('sup-form');
  f.supCode.value=s.code||''; f.supName.value=s.name||''; f.supGst.value=s.gst||'';
  f.supContact.value=s.contact||''; f.supPhone.value=s.phone||''; f.supEmail.value=s.email||'';
  f.supTerms.value=s.paymentTerms||''; f.supAddress.value=s.address||'';
  el('sup-form-id').value=id; openModal('sup-modal');
};
window.saveSupplier = async () => {
  const f = el('sup-form'); const id = el('sup-form-id').value;
  const data = { code:f.supCode.value.trim(), name:f.supName.value.trim(), gst:f.supGst.value.trim(),
    contact:f.supContact.value.trim(), phone:f.supPhone.value.trim(), email:f.supEmail.value.trim(),
    paymentTerms:f.supTerms.value.trim(), address:f.supAddress.value.trim(),
    status:'active', updatedAt:serverTimestamp() };
  if (!data.name) { toast('Supplier name required','error'); return; }
  try {
    if (id) { await updateDoc(doc(db,'suppliers',id), data); toast('Supplier updated'); }
    else { data.createdAt=serverTimestamp(); await addDoc(collection(db,'suppliers'), data); toast('Supplier added'); }
    closeModal('sup-modal');
  } catch(e) { toast(e.message,'error'); }
};
window.deleteSupplier = async (id) => {
  if (!confirm('Delete this supplier?')) return;
  await deleteDoc(doc(db,'suppliers',id)); toast('Supplier deleted');
};

// ══════════════════════════════════════════════════════════════
//  PROCESSOR MASTER
// ══════════════════════════════════════════════════════════════
function loadProcessors() {
  const unsub = onSnapshot(
    query(collection(db,'processors'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('proc-tbody');
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = emptyRow(8,'No processors added yet'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const p = d.data();
        return `<tr>
          <td class="mono c-muted">${p.code||'—'}</td>
          <td class="fw5">${p.name||'—'}</td>
          <td><span class="pill ${p.type==='dyeing'?'p-purple':'p-amber'}">${p.type||'—'}</span></td>
          <td>${p.contact||'—'}</td>
          <td class="mono">${p.phone||'—'}</td>
          <td>${p.leadTime||'—'}</td>
          <td><span class="pill ${p.status==='active'?'p-green':'p-amber'}">${p.status||'active'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="editProcessor('${d.id}')">Edit</button>
            ${canDelete()?`<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteProcessor('${d.id}')">Del</button>`:''}
          </td>
        </tr>`;
      }).join('');
    }
  );
  unsubs.push(unsub);
}
window.openAddProcessor = () => { el('proc-form').reset(); el('proc-form-id').value=''; openModal('proc-modal'); };
window.editProcessor = async (id) => {
  const snap = await getDoc(doc(db,'processors',id));
  if (!snap.exists()) return;
  const p = snap.data(); const f = el('proc-form');
  f.procCode.value=p.code||''; f.procName.value=p.name||''; f.procType.value=p.type||'dyeing';
  f.procContact.value=p.contact||''; f.procPhone.value=p.phone||''; f.procGst.value=p.gst||'';
  f.procLead.value=p.leadTime||''; f.procAddress.value=p.address||'';
  el('proc-form-id').value=id; openModal('proc-modal');
};
window.saveProcessor = async () => {
  const f = el('proc-form'); const id = el('proc-form-id').value;
  const data = { code:f.procCode.value.trim(), name:f.procName.value.trim(), type:f.procType.value,
    contact:f.procContact.value.trim(), phone:f.procPhone.value.trim(), gst:f.procGst.value.trim(),
    leadTime:f.procLead.value, address:f.procAddress.value.trim(), status:'active', updatedAt:serverTimestamp() };
  if (!data.name) { toast('Processor name required','error'); return; }
  try {
    if (id) { await updateDoc(doc(db,'processors',id), data); toast('Processor updated'); }
    else { data.createdAt=serverTimestamp(); await addDoc(collection(db,'processors'), data); toast('Processor added'); }
    closeModal('proc-modal');
  } catch(e) { toast(e.message,'error'); }
};
window.deleteProcessor = async (id) => {
  if (!confirm('Delete this processor?')) return;
  await deleteDoc(doc(db,'processors',id)); toast('Processor deleted');
};

// ══════════════════════════════════════════════════════════════
//  JOB WORKER MASTER
// ══════════════════════════════════════════════════════════════
function loadJobWorkers() {
  const unsub = onSnapshot(
    query(collection(db,'job_workers'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('jw-master-tbody');
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = emptyRow(8,'No job workers added yet'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const w = d.data();
        return `<tr>
          <td class="mono c-muted">${w.code||'—'}</td>
          <td class="fw5">${w.name||'—'}</td>
          <td>${w.workType||'—'}</td>
          <td>${w.contact||'—'}</td>
          <td class="mono">${w.rate||'—'}</td>
          <td><span class="pill ${w.status==='active'?'p-green':'p-amber'}">${w.status||'active'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="editJobWorker('${d.id}')">Edit</button>
            ${canDelete()?`<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteJobWorker('${d.id}')">Del</button>`:''}
          </td>
        </tr>`;
      }).join('');
    }
  );
  unsubs.push(unsub);
}
window.openAddJobWorker = () => { el('jw-master-form').reset(); el('jw-master-form-id').value=''; openModal('jw-master-modal'); };
window.editJobWorker = async (id) => {
  const snap = await getDoc(doc(db,'job_workers',id));
  if (!snap.exists()) return;
  const w = snap.data(); const f = el('jw-master-form');
  f.jwCode.value=w.code||''; f.jwName.value=w.name||''; f.jwType.value=w.workType||'';
  f.jwContact.value=w.contact||''; f.jwPhone.value=w.phone||''; f.jwGst.value=w.gst||'';
  f.jwRate.value=w.rate||''; f.jwAddress.value=w.address||'';
  el('jw-master-form-id').value=id; openModal('jw-master-modal');
};
window.saveJobWorker = async () => {
  const f = el('jw-master-form'); const id = el('jw-master-form-id').value;
  const data = { code:f.jwCode.value.trim(), name:f.jwName.value.trim(), workType:f.jwType.value.trim(),
    contact:f.jwContact.value.trim(), phone:f.jwPhone.value.trim(), gst:f.jwGst.value.trim(),
    rate:f.jwRate.value, address:f.jwAddress.value.trim(), status:'active', updatedAt:serverTimestamp() };
  if (!data.name) { toast('Job worker name required','error'); return; }
  try {
    if (id) { await updateDoc(doc(db,'job_workers',id), data); toast('Job worker updated'); }
    else { data.createdAt=serverTimestamp(); await addDoc(collection(db,'job_workers'), data); toast('Job worker added'); }
    closeModal('jw-master-modal');
  } catch(e) { toast(e.message,'error'); }
};
window.deleteJobWorker = async (id) => {
  if (!confirm('Delete this job worker?')) return;
  await deleteDoc(doc(db,'job_workers',id)); toast('Job worker deleted');
};

// ══════════════════════════════════════════════════════════════
//  CUSTOMER MASTER
// ══════════════════════════════════════════════════════════════
function loadCustomers() {
  const unsub = onSnapshot(
    query(collection(db,'customers'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('cust-tbody');
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = emptyRow(7,'No customers added yet'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const c = d.data();
        return `<tr>
          <td class="mono c-muted">${c.code||'—'}</td>
          <td class="fw5">${c.name||'—'}</td>
          <td class="mono">${c.gst||'—'}</td>
          <td>${c.contact||'—'}</td>
          <td class="mono">${c.phone||'—'}</td>
          <td>${c.paymentTerms||'—'}</td>
          <td><span class="pill p-green">Active</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="editCustomer('${d.id}')">Edit</button>
            ${canDelete()?`<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteCustomer('${d.id}')">Del</button>`:''}
          </td>
        </tr>`;
      }).join('');
    }
  );
  unsubs.push(unsub);
}
window.openAddCustomer = () => { el('cust-form').reset(); el('cust-form-id').value=''; openModal('cust-modal'); };
window.editCustomer = async (id) => {
  const snap = await getDoc(doc(db,'customers',id));
  if (!snap.exists()) return;
  const c = snap.data(); const f = el('cust-form');
  f.custCode.value=c.code||''; f.custName.value=c.name||''; f.custGst.value=c.gst||'';
  f.custContact.value=c.contact||''; f.custPhone.value=c.phone||''; f.custTerms.value=c.paymentTerms||'';
  f.custAddress.value=c.address||''; el('cust-form-id').value=id; openModal('cust-modal');
};
window.saveCustomer = async () => {
  const f = el('cust-form'); const id = el('cust-form-id').value;
  const data = { code:f.custCode.value.trim(), name:f.custName.value.trim(), gst:f.custGst.value.trim(),
    contact:f.custContact.value.trim(), phone:f.custPhone.value.trim(), paymentTerms:f.custTerms.value.trim(),
    address:f.custAddress.value.trim(), updatedAt:serverTimestamp() };
  if (!data.name) { toast('Customer name required','error'); return; }
  try {
    if (id) { await updateDoc(doc(db,'customers',id), data); toast('Customer updated'); }
    else { data.createdAt=serverTimestamp(); await addDoc(collection(db,'customers'), data); toast('Customer added'); }
    closeModal('cust-modal');
  } catch(e) { toast(e.message,'error'); }
};
window.deleteCustomer = async (id) => {
  if (!confirm('Delete this customer?')) return;
  await deleteDoc(doc(db,'customers',id)); toast('Customer deleted');
};

// ══════════════════════════════════════════════════════════════
//  PURCHASE ORDERS
// ══════════════════════════════════════════════════════════════
function loadPurchaseOrders() {
  const unsub = onSnapshot(
    query(collection(db,'purchase_orders'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('po-tbody');
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = emptyRow(10,'No purchase orders yet'); return; }
      let open=0, pendingGrn=0;
      tbody.innerHTML = snap.docs.map(d => {
        const p = d.data();
        const balance = Number(p.orderedQty||0) - Number(p.receivedQty||0);
        if (['draft','sent','partial'].includes(p.status)) open++;
        if (p.status==='sent') pendingGrn++;
        return `<tr>
          <td class="mono c-muted">${p.poNumber||'—'}</td>
          <td>${fmtDate(p.date)}</td>
          <td class="fw5">${p.supplier||'—'}</td>
          <td>${p.material||'—'}</td>
          <td class="mono">${fmtNum(p.orderedQty)} ${p.unit||'kg'}</td>
          <td class="mono c-green">${fmtNum(p.receivedQty||0)}</td>
          <td class="mono ${balance>0?'c-amber':''}">${fmtNum(balance)}</td>
          <td class="mono">₹${fmtNum(p.value||0)}</td>
          <td>${statusPill(p.status)}</td>
          <td>
            ${p.status!=='complete' ? `<button class="btn btn-secondary btn-sm" onclick="openGrn('${d.id}')">GRN</button>` : ''}
            <button class="btn btn-secondary btn-sm" style="margin-left:3px" onclick="editPO('${d.id}')">Edit</button>
          </td>
        </tr>`;
      }).join('');
      safeSet('po-open-count', open);
      safeSet('po-pending-grn', pendingGrn);
    }
  );
  unsubs.push(unsub);
}

window.openAddPO = () => { el('po-form').reset(); el('po-form-id').value=''; el('po-number-display').textContent='Auto-generated'; openModal('po-modal'); };
window.editPO = async (id) => {
  const snap = await getDoc(doc(db,'purchase_orders',id));
  if (!snap.exists()) return;
  const p = snap.data(); const f = el('po-form');
  f.poSupplier.value=p.supplier||''; f.poMaterial.value=p.material||'';
  f.poQty.value=p.orderedQty||''; f.poRate.value=p.rate||''; f.poGst.value=p.gstRate||'12';
  f.poRemarks.value=p.remarks||'';
  el('po-number-display').textContent=p.poNumber||''; el('po-form-id').value=id;
  openModal('po-modal');
};
window.savePO = async () => {
  const f = el('po-form'); const id = el('po-form-id').value;
  if (!f.poSupplier.value||!f.poMaterial.value||!f.poQty.value) { toast('Fill all required fields','error'); return; }
  const qty = Number(f.poQty.value); const rate = Number(f.poRate.value);
  const data = {
    supplier:f.poSupplier.value.trim(), material:f.poMaterial.value.trim(),
    orderedQty:qty, rate:rate, gstRate:f.poGst.value,
    value:qty*rate, remarks:f.poRemarks.value.trim(),
    status:'draft', receivedQty:0, updatedAt:serverTimestamp(),
    createdBy:currentUser.name||currentUser.email,
  };
  try {
    if (id) { await updateDoc(doc(db,'purchase_orders',id), data); toast('PO updated'); }
    else {
      const num = await generateNumber('PO');
      data.poNumber=num; data.date=serverTimestamp(); data.createdAt=serverTimestamp();
      await addDoc(collection(db,'purchase_orders'), data);
      await logTransaction('PO', data.material, qty, 'kg', 'draft');
      toast('Purchase order created');
    }
    closeModal('po-modal');
  } catch(e) { toast(e.message,'error'); }
};

window.openGrn = async (id) => {
  const snap = await getDoc(doc(db,'purchase_orders',id));
  if (!snap.exists()) return;
  const p = snap.data();
  el('grn-po-ref').textContent = p.poNumber;
  el('grn-material').textContent = p.material;
  el('grn-pending').textContent = `${fmtNum(Number(p.orderedQty||0)-Number(p.receivedQty||0))} kg pending`;
  el('grn-form-id').value = id;
  el('grn-qty').value = '';
  openModal('grn-modal');
};
window.saveGrn = async () => {
  const id = el('grn-form-id').value;
  const qty = Number(el('grn-qty').value);
  if (!qty) { toast('Enter received quantity','error'); return; }
  const snap = await getDoc(doc(db,'purchase_orders',id));
  if (!snap.exists()) return;
  const p = snap.data();
  const newReceived = Number(p.receivedQty||0) + qty;
  const status = newReceived >= Number(p.orderedQty) ? 'complete' : 'partial';
  try {
    await updateDoc(doc(db,'purchase_orders',id), { receivedQty:newReceived, status, updatedAt:serverTimestamp() });
    // Update material stock
    const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',p.material)));
    matSnap.forEach(async md => {
      const newStock = Number(md.data().currentStock||0) + qty;
      await updateDoc(doc(db,'materials',md.id), { currentStock:newStock, updatedAt:serverTimestamp() });
      // Add stock ledger entry
      await addDoc(collection(db,'stock'), {
        material:p.material, location:'Main Factory',
        stockIn:qty, stockOut:0, balance:newStock,
        transactionType:'GRN', reference:p.poNumber,
        createdAt:serverTimestamp(), createdBy:currentUser.name||currentUser.email,
      });
    });
    await logTransaction('GRN', p.material, qty, 'kg', 'received');
    toast('GRN saved. Stock updated.');
    closeModal('grn-modal');
  } catch(e) { toast(e.message,'error'); }
};

// ══════════════════════════════════════════════════════════════
//  STOCK — Full stock management with Add Stock Entry
// ══════════════════════════════════════════════════════════════
function loadStock() {
  // Material datalist for the Add Stock modal
  getDocs(collection(db,'materials')).then(snap => {
    const dl = el('sk-mat-list');
    if (dl) { dl.innerHTML = snap.docs.map(d=>`<option value="${d.data().name||''}">`).join(''); }
  });

  // ── Stock summary per material (from materials collection) ──
  const unsubMat = onSnapshot(
    query(collection(db,'materials'), orderBy('name')),
    snap => {
      const tbody = el('stock-summary-tbody');
      if (!tbody) return;
      let totalIn=0, totalOut=0, balance=0, low=0, total=0;
      if (snap.empty) { tbody.innerHTML = emptyRow(8,'No materials found. Add materials in Material Master first.'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const m = d.data();
        const isLow = Number(m.currentStock||0) < Number(m.reorderLevel||0) && Number(m.reorderLevel||0)>0;
        total++;
        balance += Number(m.currentStock||0);
        if (isLow) low++;
        return `<tr>
          <td class="mono c-muted">${m.code||'—'}</td>
          <td class="fw5">${m.name||'—'}</td>
          <td>${m.category||'—'}</td>
          <td>${m.unit||'Kg'}</td>
          <td class="mono fw5 ${isLow?'c-red':'c-green'}">${fmtNum(m.currentStock||0)} ${m.unit||'kg'}</td>
          <td class="mono">${fmtNum(m.reorderLevel||0)}</td>
          <td>${isLow?'<span class="pill p-red">Low Stock</span>':'<span class="pill p-green">OK</span>'}</td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="openAddStockFor('${m.name||''}')">
              <i class="ti ti-plus"></i> Add Entry
            </button>
          </td>
        </tr>`;
      }).join('');
      safeSet('sk-total-mat', total);
      safeSet('sk-balance', fmtNum(balance));
      safeSet('sk-low', low);
    }
  );
  unsubs.push(unsubMat);

  // ── Full stock ledger ──────────────────────────────────────
  const unsubLedger = onSnapshot(
    query(collection(db,'stock'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('stock-tbody');
      if (!tbody) return;
      let totalIn=0, totalOut=0;
      if (snap.empty) { tbody.innerHTML = emptyRow(10,'No stock ledger entries yet. Entries are created when you do GRN, Transfers, Dyeing, Lamination, or Job Work.'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const s = d.data();
        totalIn  += Number(s.stockIn||0);
        totalOut += Number(s.stockOut||0);
        return `<tr>
          <td class="c-muted" style="font-size:11.5px">${fmtDate(s.createdAt)}</td>
          <td class="fw5">${s.material||'—'}</td>
          <td>${s.location||'—'}</td>
          <td class="mono c-muted">${s.batch||s.lotNumber||'—'}</td>
          <td class="mono ${Number(s.stockIn||0)>0?'c-green':''}">${Number(s.stockIn||0)>0?'+'+fmtNum(s.stockIn):'—'}</td>
          <td class="mono ${Number(s.stockOut||0)>0?'c-red':''}">${Number(s.stockOut||0)>0?'−'+fmtNum(s.stockOut):'—'}</td>
          <td class="mono fw5">${fmtNum(s.balance||0)}</td>
          <td><span class="pill p-gray" style="font-size:10px">${s.transactionType||'—'}</span></td>
          <td class="mono c-muted" style="font-size:11.5px">${s.reference||'—'}</td>
          <td class="c-muted" style="font-size:11px">${s.createdBy||'—'}</td>
        </tr>`;
      }).join('');
      safeSet('sk-total-in', fmtNum(totalIn));
      safeSet('sk-total-out', fmtNum(totalOut));
    }
  );
  unsubs.push(unsubLedger);
}

// ── Open Add Stock modal ──────────────────────────────────────
window.openAddStock = () => {
  el('sk-date').value = new Date().toISOString().slice(0,10);
  el('sk-material').value = '';
  el('sk-location').value = '';
  el('sk-txn-type').value = '';
  el('sk-in').value = '0';
  el('sk-out').value = '0';
  el('sk-batch').value = '';
  el('sk-ref').value = '';
  el('sk-remarks').value = '';
  openModal('stock-modal');
};

// ── Open Add Stock pre-filled with material name ──────────────
window.openAddStockFor = (matName) => {
  window.openAddStock();
  el('sk-material').value = matName;
};

// ── Save stock entry ──────────────────────────────────────────
window.saveStockEntry = async () => {
  const material = el('sk-material').value.trim();
  const location = el('sk-location').value;
  const txnType  = el('sk-txn-type').value;
  const stockIn  = Number(el('sk-in').value) || 0;
  const stockOut = Number(el('sk-out').value) || 0;
  const batch    = el('sk-batch').value.trim();
  const ref      = el('sk-ref').value.trim();
  const remarks  = el('sk-remarks').value.trim();

  if (!material) { toast('Please enter a material name','error'); return; }
  if (!location) { toast('Please select a location','error'); return; }
  if (!txnType)  { toast('Please select a transaction type','error'); return; }
  if (stockIn === 0 && stockOut === 0) { toast('Enter Stock In or Stock Out quantity','error'); return; }

  try {
    // Find the material document to get current balance
    const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',material)));
    let currentBalance = 0;
    let matDocId = null;

    if (!matSnap.empty) {
      const matDoc = matSnap.docs[0];
      matDocId = matDoc.id;
      currentBalance = Number(matDoc.data().currentStock || 0);
    }

    const newBalance = currentBalance + stockIn - stockOut;

    // Add to stock ledger
    await addDoc(collection(db,'stock'), {
      material, location, batch, lotNumber: batch,
      stockIn, stockOut, balance: newBalance,
      transactionType: txnType,
      reference: ref || 'Manual',
      remarks,
      createdAt: serverTimestamp(),
      createdBy: currentUser.name || currentUser.email,
    });

    // Update material current stock
    if (matDocId) {
      await updateDoc(doc(db,'materials',matDocId), {
        currentStock: newBalance,
        updatedAt: serverTimestamp(),
      });
    }

    await logTransaction(txnType, material, stockIn || stockOut, 'kg', 'completed');
    toast(`✓ Stock entry saved. New balance: ${fmtNum(newBalance)} kg`);
    closeModal('stock-modal');

  } catch(e) { toast(e.message,'error'); }
};

// ══════════════════════════════════════════════════════════════
//  MATERIAL TRANSFER
// ══════════════════════════════════════════════════════════════
function loadTransfers() {
  const unsub = onSnapshot(
    query(collection(db,'transfers'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('tc-tbody');
      if (!tbody) return;
      let open=0, pending=0;
      if (snap.empty) { tbody.innerHTML = emptyRow(11,'No transfers yet'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const t = d.data();
        if (['sent','in_process','partial'].includes(t.status)) open++;
        if (t.status==='sent') pending++;
        return `<tr>
          <td class="mono c-muted">${t.tcNumber||'—'}</td>
          <td>${fmtDate(t.date)}</td>
          <td>${t.fromLocation||'—'}</td>
          <td>${t.toLocation||'—'}</td>
          <td class="fw5">${t.material||'—'}</td>
          <td class="mono">${fmtNum(t.sentQty||0)}</td>
          <td class="mono c-green">${t.receivedQty != null ? fmtNum(t.receivedQty) : '—'}</td>
          <td class="mono c-amber">${t.wastage != null ? fmtNum(t.wastage) : '—'}</td>
          <td>${fmtDate(t.expectedReturn)}</td>
          <td>${statusPill(t.status)}</td>
          <td>
            ${['sent','in_process'].includes(t.status) ? `<button class="btn btn-secondary btn-sm" onclick="receiveTransfer('${d.id}')">Receive</button>` : ''}
            ${t.status==='partial' ? `<button class="btn btn-secondary btn-sm" onclick="receiveTransfer('${d.id}')">Return</button>` : ''}
          </td>
        </tr>`;
      }).join('');
      safeSet('tc-open', open); safeSet('tc-pending', pending);
    }
  );
  unsubs.push(unsub);
}

window.openAddTransfer = () => { el('tc-form').reset(); el('tc-form-id').value=''; openModal('tc-modal'); };
window.saveTransfer = async () => {
  const f = el('tc-form');
  if (!f.tcFrom.value||!f.tcTo.value||!f.tcMaterial.value||!f.tcQty.value) { toast('Fill all required fields','error'); return; }
  const data = {
    fromLocation:f.tcFrom.value.trim(), toLocation:f.tcTo.value.trim(),
    material:f.tcMaterial.value.trim(), sentQty:Number(f.tcQty.value),
    batch:f.tcBatch.value.trim(), expectedReturn:f.tcReturn.value,
    remarks:f.tcRemarks.value.trim(), status:'sent',
    date:serverTimestamp(), createdAt:serverTimestamp(),
    createdBy:currentUser.name||currentUser.email,
  };
  try {
    const num = await generateNumber('TC');
    data.tcNumber = num;
    await addDoc(collection(db,'transfers'), data);
    // Deduct from source stock
    const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',data.material)));
    matSnap.forEach(async md => {
      const cur = Number(md.data().currentStock||0);
      await updateDoc(doc(db,'materials',md.id), { currentStock: Math.max(0,cur-data.sentQty), updatedAt:serverTimestamp() });
      await addDoc(collection(db,'stock'), {
        material:data.material, location:data.fromLocation,
        stockIn:0, stockOut:data.sentQty, balance:Math.max(0,cur-data.sentQty),
        transactionType:'Transfer Out', reference:num, createdAt:serverTimestamp(),
        createdBy:currentUser.name||currentUser.email,
      });
    });
    await logTransaction('Transfer', data.material, data.sentQty, 'kg', 'sent');
    toast(`Transfer Challan ${num} created`);
    closeModal('tc-modal');
  } catch(e) { toast(e.message,'error'); }
};

window.receiveTransfer = async (id) => {
  const snap = await getDoc(doc(db,'transfers',id));
  if (!snap.exists()) return;
  const t = snap.data();
  el('recv-tc-ref').textContent = t.tcNumber;
  el('recv-material').textContent = t.material;
  el('recv-form-id').value = id;
  el('recv-qty').value=''; el('recv-wastage').value='';
  openModal('recv-modal');
};
window.saveReceiveTransfer = async () => {
  const id = el('recv-form-id').value;
  const recvQty = Number(el('recv-qty').value);
  const wastage = Number(el('recv-wastage').value||0);
  if (!recvQty) { toast('Enter received quantity','error'); return; }
  const snap = await getDoc(doc(db,'transfers',id));
  const t = snap.data();
  const already = Number(t.receivedQty||0);
  const total = already + recvQty;
  const status = total >= Number(t.sentQty) ? 'returned' : 'partial';
  try {
    await updateDoc(doc(db,'transfers',id), { receivedQty:total, wastage:(Number(t.wastage||0)+wastage), status, updatedAt:serverTimestamp() });
    // Add back to factory stock
    const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',t.material)));
    matSnap.forEach(async md => {
      const cur = Number(md.data().currentStock||0);
      const net = recvQty - wastage;
      await updateDoc(doc(db,'materials',md.id), { currentStock: cur+net, updatedAt:serverTimestamp() });
      await addDoc(collection(db,'stock'), {
        material:t.material, location:'Main Factory',
        stockIn:net, stockOut:0, balance:cur+net,
        transactionType:'Transfer In', reference:t.tcNumber,
        createdAt:serverTimestamp(), createdBy:currentUser.name||currentUser.email,
      });
    });
    toast('Transfer received. Stock updated.');
    closeModal('recv-modal');
  } catch(e) { toast(e.message,'error'); }
};

// ══════════════════════════════════════════════════════════════
//  DYEING ORDERS
// ══════════════════════════════════════════════════════════════
function loadDyeingOrders() {
  const unsub = onSnapshot(
    query(collection(db,'dyeing_orders'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('dy-tbody');
      if (!tbody) return;
      let processing=0, overdue=0, completed=0;
      if (snap.empty) { tbody.innerHTML = emptyRow(11,'No dyeing orders yet'); return; }
      const now = new Date();
      tbody.innerHTML = snap.docs.map(d => {
        const dy = d.data();
        if (dy.status==='processing') { processing++;
          if (dy.expectedDate && new Date(dy.expectedDate) < now) overdue++; }
        if (dy.status==='completed'||dy.status==='received') completed++;
        return `<tr>
          <td class="mono c-muted">${dy.orderNumber||'—'}</td>
          <td>${fmtDate(dy.date)}</td>
          <td class="fw5">${dy.dyeingHouse||'—'}</td>
          <td>${dy.material||'—'}</td>
          <td>${dy.shade||'—'}</td>
          <td class="mono">${fmtNum(dy.inputQty||0)}</td>
          <td class="mono c-green">${dy.outputQty ? fmtNum(dy.outputQty) : '—'}</td>
          <td class="mono c-green">${dy.receivedQty ? fmtNum(dy.receivedQty) : '—'}</td>
          <td class="mono c-amber">${dy.wastage ? fmtNum(dy.wastage) : '—'}</td>
          <td class="mono c-amber">${fmtNum(Number(dy.inputQty||0)-Number(dy.receivedQty||0))}</td>
          <td>${statusPill(dy.status)}</td>
          <td>
            ${dy.status==='processing' ? `<button class="btn btn-secondary btn-sm" onclick="receiveDyeing('${d.id}')">Receive</button>` : ''}
          </td>
        </tr>`;
      }).join('');
      safeSet('dy-processing', processing); safeSet('dy-overdue', overdue); safeSet('dy-completed', completed);
    }
  );
  unsubs.push(unsub);
}

window.openAddDyeing = () => { el('dy-form').reset(); el('dy-form-id').value=''; openModal('dy-modal'); };
window.saveDyeingOrder = async () => {
  const f = el('dy-form');
  if (!f.dyHouse.value||!f.dyMaterial.value||!f.dyQty.value) { toast('Fill required fields','error'); return; }
  const data = {
    dyeingHouse:f.dyHouse.value.trim(), material:f.dyMaterial.value.trim(),
    shade:f.dyShade.value.trim(), inputQty:Number(f.dyQty.value),
    expectedDate:f.dyDate.value, remarks:f.dyRemarks.value.trim(),
    status:'processing', receivedQty:0, outputQty:0, wastage:0,
    date:serverTimestamp(), createdAt:serverTimestamp(),
    createdBy:currentUser.name||currentUser.email,
  };
  try {
    const num = await generateNumber('DY');
    data.orderNumber = num;
    await addDoc(collection(db,'dyeing_orders'), data);
    // Deduct stock
    await deductStock(data.material, data.inputQty, data.dyeingHouse, num, 'Dyeing Issue');
    await logTransaction('Dyeing', data.material, data.inputQty, 'kg', 'processing');
    toast(`Dyeing order ${num} created`);
    closeModal('dy-modal');
  } catch(e) { toast(e.message,'error'); }
};

window.receiveDyeing = async (id) => {
  const snap = await getDoc(doc(db,'dyeing_orders',id));
  if (!snap.exists()) return;
  const d = snap.data();
  el('dy-recv-ref').textContent = d.orderNumber;
  el('dy-recv-material').textContent = `${d.material} — Input: ${fmtNum(d.inputQty)} kg`;
  el('dy-recv-form-id').value = id;
  el('dy-recv-qty').value=''; el('dy-recv-wastage').value=''; el('dy-recv-rejection').value='';
  openModal('dy-recv-modal');
};
window.saveDyeingReceipt = async () => {
  const id = el('dy-recv-form-id').value;
  const recvQty = Number(el('dy-recv-qty').value);
  const wastage = Number(el('dy-recv-wastage').value||0);
  const rejection = Number(el('dy-recv-rejection').value||0);
  if (!recvQty) { toast('Enter received quantity','error'); return; }
  try {
    await updateDoc(doc(db,'dyeing_orders',id), {
      receivedQty:recvQty, outputQty:recvQty, wastage, rejection,
      status:'received', updatedAt:serverTimestamp()
    });
    // Add back to stock
    const snap = await getDoc(doc(db,'dyeing_orders',id));
    const d = snap.data();
    const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',d.material)));
    matSnap.forEach(async md => {
      const cur = Number(md.data().currentStock||0);
      await updateDoc(doc(db,'materials',md.id), { currentStock:cur+recvQty, updatedAt:serverTimestamp() });
      await addDoc(collection(db,'stock'), {
        material:d.material, location:'Main Factory',
        stockIn:recvQty, stockOut:0, balance:cur+recvQty,
        transactionType:'Dyeing Receipt', reference:d.orderNumber,
        createdAt:serverTimestamp(), createdBy:currentUser.name||currentUser.email,
      });
    });
    toast('Dyeing receipt saved. Stock updated.');
    closeModal('dy-recv-modal');
  } catch(e) { toast(e.message,'error'); }
};

// ══════════════════════════════════════════════════════════════
//  LAMINATION ORDERS
// ══════════════════════════════════════════════════════════════
function loadLaminationOrders() {
  const unsub = onSnapshot(
    query(collection(db,'lamination_orders'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('lm-tbody');
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = emptyRow(11,'No lamination orders yet'); return; }
      tbody.innerHTML = snap.docs.map(d => {
        const lm = d.data();
        return `<tr>
          <td class="mono c-muted">${lm.orderNumber||'—'}</td>
          <td>${fmtDate(lm.date)}</td>
          <td class="fw5">${lm.laminationHouse||'—'}</td>
          <td>${lm.material||'—'}</td>
          <td>${lm.laminationType||'—'}</td>
          <td class="mono">${fmtNum(lm.inputQty||0)}</td>
          <td class="mono c-green">${lm.outputQty ? fmtNum(lm.outputQty) : '—'}</td>
          <td class="mono c-green">${lm.receivedQty ? fmtNum(lm.receivedQty) : '—'}</td>
          <td class="mono c-amber">${lm.wastage ? fmtNum(lm.wastage) : '—'}</td>
          <td class="mono c-amber">${fmtNum(Number(lm.inputQty||0)-Number(lm.receivedQty||0))}</td>
          <td>${statusPill(lm.status)}</td>
          <td>${lm.status==='processing' ? `<button class="btn btn-secondary btn-sm" onclick="receiveLamination('${d.id}')">Receive</button>` : ''}</td>
        </tr>`;
      }).join('');
    }
  );
  unsubs.push(unsub);
}

window.openAddLamination = () => { el('lm-form').reset(); el('lm-form-id').value=''; openModal('lm-modal'); };
window.saveLamination = async () => {
  const f = el('lm-form');
  if (!f.lmHouse.value||!f.lmMaterial.value||!f.lmQty.value) { toast('Fill required fields','error'); return; }
  const data = {
    laminationHouse:f.lmHouse.value.trim(), material:f.lmMaterial.value.trim(),
    laminationType:f.lmType.value.trim(), inputQty:Number(f.lmQty.value),
    expectedDate:f.lmDate.value, remarks:f.lmRemarks.value.trim(),
    status:'processing', receivedQty:0, outputQty:0, wastage:0,
    date:serverTimestamp(), createdAt:serverTimestamp(),
    createdBy:currentUser.name||currentUser.email,
  };
  try {
    const num = await generateNumber('LM');
    data.orderNumber = num;
    await addDoc(collection(db,'lamination_orders'), data);
    await deductStock(data.material, data.inputQty, data.laminationHouse, num, 'Lamination Issue');
    await logTransaction('Lamination', data.material, data.inputQty, 'kg', 'processing');
    toast(`Lamination order ${num} created`);
    closeModal('lm-modal');
  } catch(e) { toast(e.message,'error'); }
};

window.receiveLamination = async (id) => {
  const snap = await getDoc(doc(db,'lamination_orders',id));
  if (!snap.exists()) return;
  const lm = snap.data();
  el('lm-recv-ref').textContent = lm.orderNumber;
  el('lm-recv-material').textContent = `${lm.material} — Input: ${fmtNum(lm.inputQty)} kg`;
  el('lm-recv-form-id').value = id;
  el('lm-recv-qty').value=''; el('lm-recv-wastage').value='';
  openModal('lm-recv-modal');
};
window.saveLaminationReceipt = async () => {
  const id = el('lm-recv-form-id').value;
  const recvQty = Number(el('lm-recv-qty').value);
  const wastage = Number(el('lm-recv-wastage').value||0);
  if (!recvQty) { toast('Enter received quantity','error'); return; }
  try {
    await updateDoc(doc(db,'lamination_orders',id), {
      receivedQty:recvQty, outputQty:recvQty, wastage, status:'received', updatedAt:serverTimestamp()
    });
    const snap = await getDoc(doc(db,'lamination_orders',id));
    const lm = snap.data();
    const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',lm.material)));
    matSnap.forEach(async md => {
      const cur = Number(md.data().currentStock||0);
      await updateDoc(doc(db,'materials',md.id), { currentStock:cur+recvQty, updatedAt:serverTimestamp() });
      await addDoc(collection(db,'stock'), {
        material:lm.material, location:'Main Factory',
        stockIn:recvQty, stockOut:0, balance:cur+recvQty,
        transactionType:'Lamination Receipt', reference:lm.orderNumber,
        createdAt:serverTimestamp(), createdBy:currentUser.name||currentUser.email,
      });
    });
    toast('Lamination receipt saved. Stock updated.');
    closeModal('lm-recv-modal');
  } catch(e) { toast(e.message,'error'); }
};

// ══════════════════════════════════════════════════════════════
//  JOB WORK
// ══════════════════════════════════════════════════════════════
function loadJobWork() {
  const unsub = onSnapshot(
    query(collection(db,'job_work'), orderBy('createdAt','desc')),
    snap => {
      const tbody = el('jw-tbody');
      if (!tbody) return;
      let pending=0, overdue=0, totalCharges=0;
      if (snap.empty) { tbody.innerHTML = emptyRow(11,'No job work orders yet'); return; }
      const now = new Date();
      tbody.innerHTML = snap.docs.map(d => {
        const j = d.data();
        const isOverdue = j.dueDate && new Date(j.dueDate) < now && j.status!=='received';
        if (j.status==='issued') { pending++; if(isOverdue) overdue++; }
        totalCharges += Number(j.jobCharges||0);
        return `<tr>
          <td class="mono c-muted">${j.jobNumber||'—'}</td>
          <td>${fmtDate(j.date)}</td>
          <td class="fw5">${j.jobWorker||'—'}</td>
          <td>${j.material||'—'}</td>
          <td class="mono">${fmtNum(j.issuedQty||0)}</td>
          <td class="mono c-green">${j.receivedQty ? fmtNum(j.receivedQty) : '—'}</td>
          <td class="mono c-amber">${j.wastage ? fmtNum(j.wastage) : '—'}</td>
          <td class="mono">₹${fmtNum(j.jobCharges||0)}</td>
          <td class="${isOverdue?'c-red':''}">${j.dueDate||'—'}</td>
          <td>${isOverdue ? '<span class="pill p-red">Overdue</span>' : statusPill(j.status)}</td>
          <td>${j.status==='issued' ? `<button class="btn btn-secondary btn-sm" onclick="receiveJobWork('${d.id}')">Receive</button>` : ''}</td>
        </tr>`;
      }).join('');
      safeSet('jw-pending', pending); safeSet('jw-overdue', overdue); safeSet('jw-charges', '₹'+fmtNum(totalCharges));
    }
  );
  unsubs.push(unsub);
}

window.openAddJobWork = () => { el('jw-form').reset(); el('jw-form-id').value=''; openModal('jw-modal'); };
window.saveJobWork = async () => {
  const f = el('jw-form');
  if (!f.jwWorker.value||!f.jwMaterial.value||!f.jwQty.value) { toast('Fill required fields','error'); return; }
  const qty = Number(f.jwQty.value); const rate = Number(f.jwRate.value||0);
  const data = {
    jobWorker:f.jwWorker.value.trim(), material:f.jwMaterial.value.trim(),
    issuedQty:qty, jobRate:rate, jobCharges:qty*rate,
    dueDate:f.jwDue.value, remarks:f.jwRemarks.value.trim(),
    status:'issued', receivedQty:0, wastage:0,
    date:serverTimestamp(), createdAt:serverTimestamp(),
    createdBy:currentUser.name||currentUser.email,
  };
  try {
    const num = await generateNumber('JW');
    data.jobNumber = num;
    await addDoc(collection(db,'job_work'), data);
    await deductStock(data.material, data.issuedQty, data.jobWorker, num, 'Job Work Issue');
    await logTransaction('Job Work', data.material, data.issuedQty, 'kg', 'issued');
    toast(`Job work ${num} issued`);
    closeModal('jw-modal');
  } catch(e) { toast(e.message,'error'); }
};

window.receiveJobWork = async (id) => {
  const snap = await getDoc(doc(db,'job_work',id));
  if (!snap.exists()) return;
  const j = snap.data();
  el('jw-recv-ref').textContent = j.jobNumber;
  el('jw-recv-worker').textContent = `${j.jobWorker} — ${j.material}, ${fmtNum(j.issuedQty)} kg issued`;
  el('jw-recv-form-id').value = id;
  el('jw-recv-qty').value=''; el('jw-recv-wastage').value=''; el('jw-recv-rejection').value='';
  openModal('jw-recv-modal');
};
window.saveJobWorkReceipt = async () => {
  const id = el('jw-recv-form-id').value;
  const recvQty = Number(el('jw-recv-qty').value);
  const wastage = Number(el('jw-recv-wastage').value||0);
  const rejection = Number(el('jw-recv-rejection').value||0);
  if (!recvQty) { toast('Enter received quantity','error'); return; }
  try {
    const snap = await getDoc(doc(db,'job_work',id));
    const j = snap.data();
    const charges = Number(j.jobRate||0) * recvQty;
    await updateDoc(doc(db,'job_work',id), {
      receivedQty:recvQty, wastage, rejection, jobCharges:charges,
      status:'received', updatedAt:serverTimestamp()
    });
    const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',j.material)));
    matSnap.forEach(async md => {
      const cur = Number(md.data().currentStock||0);
      const net = recvQty - wastage - rejection;
      await updateDoc(doc(db,'materials',md.id), { currentStock:cur+net, updatedAt:serverTimestamp() });
      await addDoc(collection(db,'stock'), {
        material:j.material, location:'Main Factory',
        stockIn:net, stockOut:0, balance:cur+net,
        transactionType:'Job Work Receipt', reference:j.jobNumber,
        createdAt:serverTimestamp(), createdBy:currentUser.name||currentUser.email,
      });
    });
    toast('Job work receipt saved. Stock updated.');
    closeModal('jw-recv-modal');
  } catch(e) { toast(e.message,'error'); }
};

// ══════════════════════════════════════════════════════════════
//  USERS — Full Admin Management
//  Uses Firebase Auth REST API to create users without signing out
// ══════════════════════════════════════════════════════════════

const ROLE_DESCRIPTIONS = {
  admin:      'Full access to all 14 modules including User Management',
  store:      'Stock Management, Material Transfer, Material Master',
  purchase:   'Purchase Orders, GRN, Supplier Master, Stock (view)',
  production: 'Stock, Transfer, Dyeing, Lamination, Job Work',
  dyeing:     'Dyeing Orders and Material Transfer only',
  lamination: 'Lamination Orders and Material Transfer only',
  jobcoord:   'Job Work Management and Material Transfer only',
  accounts:   'Reports, Purchase (view), Stock (view) — read-only access',
};

function loadUsers() {
  if (currentRole !== 'admin') {
    if (el('users-tbody')) el('users-tbody').innerHTML = emptyRow(6, 'Access denied — Admin only');
    return;
  }

  const unsub = onSnapshot(
    query(collection(db, 'users'), orderBy('createdAt', 'desc')),
    snap => {
      const tbody = el('users-tbody');
      if (!tbody) return;

      // Update stats
      let total = 0, active = 0, inactive = 0, admins = 0;
      snap.forEach(d => {
        total++;
        const u = d.data();
        if (u.status === 'inactive') inactive++;
        else active++;
        if (u.role === 'admin') admins++;
      });
      safeSet('stat-total', total);
      safeSet('stat-active', active);
      safeSet('stat-inactive', inactive);
      safeSet('stat-admins', admins);

      if (snap.empty) { tbody.innerHTML = emptyRow(6, 'No users yet. Click "Create New User" to add staff.'); return; }

      tbody.innerHTML = snap.docs.map(d => {
        const u = d.data();
        const isYou = d.id === currentUser.uid;
        const isActive = u.status !== 'inactive';
        const rolePillClass = {
          admin:'p-purple', store:'p-green', purchase:'p-amber',
          production:'p-gray', dyeing:'p-blue', lamination:'p-amber',
          jobcoord:'p-gray', accounts:'p-gray'
        }[u.role] || 'p-gray';

        return `<tr style="${isActive ? '' : 'opacity:.55'}">
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:28px;height:28px;border-radius:50%;background:var(--accent-green);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#0d0f14;flex-shrink:0">
                ${(u.name||'U').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
              </div>
              <div>
                <div class="fw5" style="font-size:13px">${u.name||'—'}</div>
                ${u.phone ? `<div class="c-muted" style="font-size:11px">${u.phone}</div>` : ''}
              </div>
            </div>
          </td>
          <td class="mono c-muted" style="font-size:11.5px">${u.email||'—'}</td>
          <td><span class="pill ${rolePillClass}">${u.role||'—'}</span></td>
          <td class="c-muted" style="font-size:11.5px">${fmtDate(u.createdAt)||'—'}</td>
          <td>${isActive
            ? '<span class="pill p-green">Active</span>'
            : '<span class="pill p-red">Deactivated</span>'}</td>
          <td>
            ${isYou
              ? '<span class="c-muted" style="font-size:11.5px">You</span>'
              : `<div style="display:flex;gap:5px">
                   <button class="btn btn-secondary btn-sm" onclick="openEditUser('${d.id}')"><i class="ti ti-edit"></i> Edit</button>
                   <button class="btn btn-danger btn-sm" onclick="openDeleteUser('${d.id}','${(u.name||'').replace(/'/g,"\\'")}')"><i class="ti ti-trash"></i></button>
                 </div>`
            }
          </td>
        </tr>`;
      }).join('');
    }
  );
  unsubs.push(unsub);
}

// ── Role description hint ─────────────────────────────────────
const roleSelect = document.getElementById('u-role');
if (roleSelect) {
  roleSelect.addEventListener('change', function() {
    const box = el('role-desc-box');
    const txt = el('role-desc-text');
    if (this.value && ROLE_DESCRIPTIONS[this.value]) {
      txt.textContent = ROLE_DESCRIPTIONS[this.value];
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
  });
}

// ── Open create user modal ────────────────────────────────────
window.openAddUser = () => {
  if (currentRole !== 'admin') { toast('Only admins can create users', 'error'); return; }
  // Reset form
  el('user-modal-title').textContent = 'Create New User';
  el('user-save-label').textContent = 'Create User';
  el('user-edit-uid').value = '';
  el('u-name').value = '';
  el('u-email').value = '';
  el('u-pass').value = '';
  el('u-role').value = '';
  el('u-phone').value = '';
  el('u-dept').value = '';
  el('u-pass-group').style.display = '';
  el('user-create-info').style.display = '';
  el('role-desc-box').style.display = 'none';
  openModal('user-modal');
};

// ── Save user (create via Firebase Auth REST API) ─────────────
window.saveUser = async () => {
  const name  = el('u-name').value.trim();
  const email = el('u-email').value.trim();
  const pass  = el('u-pass').value;
  const role  = el('u-role').value;
  const phone = el('u-phone').value.trim();
  const dept  = el('u-dept').value.trim();

  if (!name)  { toast('Please enter a name', 'error'); return; }
  if (!email) { toast('Please enter an email address', 'error'); return; }
  if (!pass || pass.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
  if (!role)  { toast('Please select a role', 'error'); return; }

  const btn = el('user-save-btn');
  btn.disabled = true;
  el('user-save-label').textContent = 'Creating...';

  try {
    // Use Firebase Auth REST API to create user without affecting current session
    const apiKey = firebaseConfig.apiKey;
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass, returnSecureToken: false }),
      }
    );
    const data = await res.json();

    if (!res.ok) {
      const msg = data.error?.message || 'Failed to create user';
      if (msg === 'EMAIL_EXISTS') throw new Error('This email is already registered.');
      if (msg === 'INVALID_EMAIL') throw new Error('Please enter a valid email address.');
      if (msg === 'WEAK_PASSWORD : Password should be at least 6 characters') throw new Error('Password too weak — use at least 6 characters.');
      throw new Error(msg);
    }

    const uid = data.localId;

    // Save user profile to Firestore users collection
    const { setDoc: setDocFn } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await setDocFn(doc(db, 'users', uid), {
      name, email, role, phone, department: dept,
      status: 'active',
      createdAt: serverTimestamp(),
      createdBy: currentUser.name || currentUser.email,
    });

    toast(`✓ User "${name}" created successfully. Share their email & password with them.`, 'success');
    closeModal('user-modal');

  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    el('user-save-label').textContent = 'Create User';
  }
};

// ── Open edit user modal ──────────────────────────────────────
window.openEditUser = async (uid) => {
  if (currentRole !== 'admin') { toast('Only admins can edit users', 'error'); return; }
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) { toast('User not found', 'error'); return; }
    const u = snap.data();
    el('edit-uid').value = uid;
    el('edit-user-name-display').textContent = u.name || '—';
    el('edit-user-email-display').textContent = u.email || '—';
    el('edit-name').value = u.name || '';
    el('edit-phone').value = u.phone || '';
    el('edit-role').value = u.role || 'store';
    el('edit-status').value = u.status || 'active';
    el('edit-pass').value = '';
    openModal('user-edit-modal');
  } catch(e) { toast(e.message, 'error'); }
};

// ── Save user edits ───────────────────────────────────────────
window.saveUserEdit = async () => {
  const uid    = el('edit-uid').value;
  const name   = el('edit-name').value.trim();
  const phone  = el('edit-phone').value.trim();
  const role   = el('edit-role').value;
  const status = el('edit-status').value;
  const newPass = el('edit-pass').value;

  if (!name) { toast('Name cannot be empty', 'error'); return; }
  if (!role) { toast('Please select a role', 'error'); return; }

  try {
    // Update Firestore profile
    await updateDoc(doc(db, 'users', uid), {
      name, phone, role, status, updatedAt: serverTimestamp(),
      updatedBy: currentUser.name || currentUser.email,
    });

    // If new password provided, update via REST API
    if (newPass) {
      if (newPass.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
      const apiKey = firebaseConfig.apiKey;
      // Need the user's idToken — we can only reset password via email for security
      // So we use the sendPasswordResetEmail approach via REST
      const resetRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: el('edit-user-email-display').textContent }),
        }
      );
      if (resetRes.ok) {
        toast('Profile updated. A password reset email has been sent to the user.', 'success');
      } else {
        toast('Profile updated. Could not send password reset email.', 'info');
      }
    } else {
      toast(`✓ User "${name}" updated successfully.`, 'success');
    }

    closeModal('user-edit-modal');
  } catch(e) { toast(e.message, 'error'); }
};

// ── Open delete confirm ───────────────────────────────────────
window.openDeleteUser = (uid, name) => {
  if (uid === currentUser.uid) { toast('You cannot remove your own account', 'error'); return; }
  el('delete-uid').value = uid;
  el('delete-user-name').textContent = name;
  openModal('user-delete-modal');
};

// ── Confirm delete ────────────────────────────────────────────
window.confirmDeleteUser = async () => {
  const uid = el('delete-uid').value;
  if (!uid) return;
  try {
    // Mark as inactive in Firestore (preserve audit trail)
    await updateDoc(doc(db, 'users', uid), {
      status: 'inactive',
      deactivatedAt: serverTimestamp(),
      deactivatedBy: currentUser.name || currentUser.email,
    });
    toast('User deactivated. They can no longer log in.', 'success');
    closeModal('user-delete-modal');
  } catch(e) { toast(e.message, 'error'); }
};

// ══════════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════════
window.generateReport = async (type) => {
  const from = el('rpt-from').value;
  const to = el('rpt-to').value;
  const location = el('rpt-location')?.value || 'all';
  toast(`Generating ${type} report...`, 'info');

  // Build query based on report type
  const colMap = {
    'Stock Summary':'stock', 'Purchase':'purchase_orders',
    'Dyeing':'dyeing_orders', 'Lamination':'lamination_orders',
    'Job Work':'job_work', 'Transfer':'transfers',
  };
  const col = colMap[type];
  if (!col) { toast('Export to Excel/PDF coming soon','info'); return; }

  try {
    const snap = await getDocs(collection(db, col));
    const rows = snap.docs.map(d => d.data());
    downloadCSV(rows, type);
  } catch(e) { toast(e.message,'error'); }
};

function downloadCSV(data, name) {
  if (!data.length) { toast('No data to export','info'); return; }
  const keys = Object.keys(data[0]).filter(k => !['createdAt','updatedAt'].includes(k));
  const rows = [keys.join(','), ...data.map(r => keys.map(k => JSON.stringify(r[k]||'')).join(','))];
  const blob = new Blob([rows.join('\n')], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  toast(`${name} exported as CSV`);
}

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════
async function generateNumber(prefix) {
  const year = new Date().getFullYear();
  const snap = await getDocs(collection(db, 'counters'));
  let counter = snap.docs.find(d => d.id === prefix);
  let seq = 1;
  if (counter) {
    seq = (counter.data().seq||0) + 1;
    await updateDoc(doc(db,'counters',prefix), { seq });
  } else {
    await addDoc(collection(db,'counters'), { seq:1, id:prefix });
    // Use setDoc instead
    const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await setDoc(doc(db,'counters',prefix), { seq:1 });
  }
  return `${prefix}-${year}-${String(seq).padStart(3,'0')}`;
}

async function logTransaction(type, material, qty, unit, status) {
  await addDoc(collection(db,'transactions'), {
    type, material, qty, unit, status,
    createdAt:serverTimestamp(), createdBy:currentUser.name||currentUser.email,
  });
}

async function deductStock(material, qty, location, reference, txnType) {
  const matSnap = await getDocs(query(collection(db,'materials'), where('name','==',material)));
  matSnap.forEach(async md => {
    const cur = Number(md.data().currentStock||0);
    const newStock = Math.max(0, cur - qty);
    await updateDoc(doc(db,'materials',md.id), { currentStock:newStock, updatedAt:serverTimestamp() });
    await addDoc(collection(db,'stock'), {
      material, location, stockIn:0, stockOut:qty, balance:newStock,
      transactionType:txnType, reference,
      createdAt:serverTimestamp(), createdBy:currentUser.name||currentUser.email,
    });
  });
}

function canDelete() { return ['admin','store'].includes(currentRole); }
function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-muted);padding:30px 10px"><i class="ti ti-database-off" style="display:block;font-size:24px;margin-bottom:6px;opacity:.4"></i>${msg}</td></tr>`;
}

function statusPill(status) {
  const map = {
    draft:'<span class="pill p-gray">Draft</span>',
    sent:'<span class="pill p-blue">Sent</span>',
    partial:'<span class="pill p-amber">Partial</span>',
    complete:'<span class="pill p-green">Complete</span>',
    active:'<span class="pill p-green">Active</span>',
    processing:'<span class="pill p-blue">Processing</span>',
    in_process:'<span class="pill p-blue">In Process</span>',
    received:'<span class="pill p-green">Received</span>',
    returned:'<span class="pill p-green">Returned</span>',
    issued:'<span class="pill p-amber">Issued</span>',
    overdue:'<span class="pill p-red">Overdue</span>',
    closed:'<span class="pill p-gray">Closed</span>',
    grn:'<span class="pill p-blue">GRN</span>',
    po:'<span class="pill p-blue">PO</span>',
    transfer:'<span class="pill p-purple">Transfer</span>',
    dyeing:'<span class="pill p-purple">Dyeing</span>',
    lamination:'<span class="pill p-amber">Lamination</span>',
    'job work':'<span class="pill p-gray">Job Work</span>',
  };
  return map[(status||'').toLowerCase()] || `<span class="pill p-gray">${status||'—'}</span>`;
}
function typePill(type) { return statusPill(type); }
