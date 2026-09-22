// ============================================================
// PANDA CONSTRUCTION — FIRESTORE DATA LAYER
// Same PandaAPI.call(action, payload) interface the app already uses —
// index.html needs no changes. Backed by Firestore instead of Google Sheets.
// ============================================================
(function () {
  const db = window.fsdb;
  const USER_PASSWORDS = { "Subrat Panda": "00000", "Hrushikesh Padhi": "955690", "Ayaskanta Giri": "22222", "Sukadev": "33333" };

  // Business-style IDs (e.g. "PAY7"), kept sequential via a counters doc so tables still read
  // like "SL No 1, 2, 3..." instead of random strings. Verifies against the actual collection
  // so it can never hand out an ID that's already in use (avoids silent overwrites).
  function nextId(counterName, prefix, coll) {
    const ref = db.collection("meta").doc("counters");
    return db.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        const data = snap.exists ? snap.data() : {};
        const n = (data[counterName] || 0) + 1;
        const update = {}; update[counterName] = n;
        tx.set(ref, update, { merge: true });
        return prefix + n;
      });
    }).then(async function (id) {
      if (!coll) return id;
      const exists = await db.collection(coll).doc(String(id)).get();
      if (!exists.exists) return id;
      // counter was stale (e.g. migrated data written after counter last advanced) — bump past
      // the real max in this collection and retry once.
      const snap = await db.collection(coll).get();
      let maxN = 0;
      snap.docs.forEach(function (d) { const num = Number(String(d.id).replace(prefix, "")); if (!isNaN(num) && num > maxN) maxN = num; });
      const update = {}; update[counterName] = maxN;
      await ref.set(update, { merge: true });
      return nextId(counterName, prefix, coll);
    });
  }

  async function auditLog(user, action, module, recordId, details) {
    await db.collection("auditLog").add({ Timestamp: new Date().toISOString(), User: user || "", Action: action, Module: module, RecordID: String(recordId), Details: details || "" });
  }

  async function colToArray(name) {
    const snap = await db.collection(name).get({ source: "server" });
    return snap.docs.map(function (d) { return d.data(); });
  }
  async function colToArraySince(name, sinceDate) {
    if (!sinceDate) return colToArray(name);
    const snap = await db.collection(name).where("Date", ">=", sinceDate).get({ source: "server" });
    return snap.docs.map(function (d) { return d.data(); });
  }
  // The earliest BF date across all BF ledgers is the oldest date any balance calc still needs
  // (everything downstream already filters transactions to "date > bfDate"). Anything before that
  // is dead weight on every load — fetched on demand instead, via getDateRange, when a report
  // filter asks for it. Returns null (no cutoff, full load) until at least one BF row exists.
  async function computeLoadCutoff() {
    const bfColls = ["bf", "dieselBF", "staffBF", "labourBF", "mistriBF"];
    const arrs = await Promise.all(bfColls.map(colToArray));
    let minDate = null;
    arrs.forEach(function (arr) {
      arr.forEach(function (r) { if (r.BFDate && (!minDate || r.BFDate < minDate)) minDate = r.BFDate; });
    });
    return minDate;
  }

  // Parses a BF month label ("August 2026") into a sortable "2026-08" key. Selecting the
  // "latest" BF row by raw BFDate string was fragile (typos, blank dates, ties) and caused
  // real mismatches between the BF list and a supplier/staff/labour/mistri's detail page —
  // month-key is the source of truth for ordering; BFDate only breaks ties.
  // Parses a BF month label ("August" or "August 2026") into a sortable "2026-08" key.
  // Regex-based (not Date-string parsing) because "Month Year" strings like "September 2026"
  // are ambiguous/invalid to the Date constructor and silently returned "" before this fix.
  function monthKeyOfLabel(label) {
    const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const s = String(label || "").trim().toLowerCase();
    if (!s) return "";
    const yearMatch = s.match(/\d{4}/);
    const year = yearMatch ? yearMatch[0] : String(new Date().getFullYear());
    const idx = names.findIndex(function (m) { return s.indexOf(m) !== -1 || s.indexOf(m.slice(0, 3)) !== -1; });
    if (idx === -1) return "";
    return year + "-" + String(idx + 1).padStart(2, "0");
  }
  function pickLatestBFRow(rows) {
    if (!rows || !rows.length) return null;
    return rows.reduce(function (best, r) {
      if (!best) return r;
      const bk = monthKeyOfLabel(best.BFMonth), rk = monthKeyOfLabel(r.BFMonth);
      if (rk && bk && rk !== bk) return rk > bk ? r : best;
      const bd = best.BFDate || "", rd = r.BFDate || "";
      if (rd !== bd) return rd > bd ? r : best;
      return r;
    }, null);
  }

  // ---------- collection map: action-family -> {coll, idField, counter, prefix} ----------
  const MAP = {
    Supplier: { coll: "suppliers", idField: "SupplierID", counter: "SupplierID", prefix: "SUP", def: { Status: "Active" } },
    Transaction: { coll: "transactions", idField: "SLNo", counter: "SLNo", prefix: "" },
    Payment: { coll: "payments", idField: "PaymentID", counter: "PaymentID", prefix: "PAY", def: { Status: "Active" } },
    DieselTransaction: { coll: "dieselTx", idField: "SLNo", counter: "DieselSLNo", prefix: "" },
    DieselPayment: { coll: "dieselPayments", idField: "PaymentID", counter: "DieselPaymentID", prefix: "DPAY", def: { Status: "Active" } },
    Site: { coll: "sites", idField: "SiteID", counter: "SiteID", prefix: "S", def: { Status: "Active" } },
    Vehicle: { coll: "vehicles", idField: "VehicleID", counter: "VehicleID", prefix: "VEH", def: { Status: "Active" } },
    VehicleLog: { coll: "vehicleDailyLog", idField: "LogID", counter: "VehicleLogID", prefix: "VLOG" },
    Material: { coll: "materials", idField: "MaterialID", counter: "MaterialID", prefix: "M", def: { Status: "Active" } },
    Staff: { coll: "staff", idField: "StaffID", counter: "StaffID", prefix: "ST", def: { Status: "Active" } },
    StaffSalary: { coll: "staffSalary", idField: "SalaryID", counter: "SalaryID", prefix: "SAL" },
    StaffPayment: { coll: "staffPayments", idField: "PaymentID", counter: "StaffPaymentID", prefix: "SPAY" },
    StaffAttendance: { coll: "staffAttendance", idField: "AttendanceID", counter: "AttendanceID", prefix: "ATT" },
    Mistri: { coll: "mistri", idField: "MistriID", counter: "MistriID", prefix: "MI", def: { Status: "Active" } },
    MistriDue: { coll: "mistriDue", idField: "DueID", counter: "DueID", prefix: "MD" },
    MistriPayment: { coll: "mistriPayments", idField: "PaymentID", counter: "MistriPaymentID", prefix: "MP", def: { Status: "Active" } },
    MistriAdvance: { coll: "mistriAdvances", idField: "AdvanceID", counter: "MistriAdvanceID", prefix: "MA", def: { Status: "Active" } },
    Labour: { coll: "labour", idField: "LabourID", counter: "LabourID", prefix: "LB", def: { Status: "Active" } },
    LabourEntry: { coll: "labourEntries", idField: "EntryID", counter: "EntryID", prefix: "LE" },
    LabourPayment: { coll: "labourPayments", idField: "PaymentID", counter: "LabourPaymentID", prefix: "LP", def: { Status: "Active" } },
    LabourAdvance: { coll: "labourAdvances", idField: "AdvanceID", counter: "LabourAdvanceID", prefix: "LA", def: { Status: "Active" } },
    StaffBF: { coll: "staffBF", idField: "BFID", counter: "StaffBFID", prefix: "SBF" },
    LabourBF: { coll: "labourBF", idField: "BFID", counter: "LabourBFID", prefix: "LBF" },
    MistriBF: { coll: "mistriBF", idField: "BFID", counter: "MistriBFID", prefix: "MBF" },
    FundTransfer: { coll: "fundTransfers", idField: "TransferID", counter: "TransferID", prefix: "FT", def: { Status: "Active" } },
    SiteAllocation: { coll: "siteAllocations", idField: "AllocationID", counter: "AllocationID", prefix: "SA", def: { Status: "Active" } },
    DriverAllocation: { coll: "driverAllocations", idField: "AllocationID", counter: "DriverAllocationID", prefix: "DA", def: { Status: "Active" } },
    DuplicateReview: { coll: "duplicateReviews", idField: "ReviewID", counter: "DuplicateReviewID", prefix: "DUP" },
    SiteExpense: { coll: "siteExpenses", idField: "ExpenseID", counter: "ExpenseID", prefix: "SE", def: { Status: "Active" } },
    SiteTransfer: { coll: "siteTransfers", idField: "TransferID", counter: "SiteTransferID", prefix: "STX", def: { Status: "Active" } },
    OtherPayment: { coll: "otherPayments", idField: "PaymentID", counter: "OtherPaymentID", prefix: "OTH", def: { Status: "Active" } },
    CementReceived: { coll: "cementReceived", idField: "ReceiptID", counter: "CementReceivedID", prefix: "CR", def: { Status: "Active" } },
    CementUsed: { coll: "cementUsed", idField: "UsageID", counter: "CementUsedID", prefix: "CU", def: { Status: "Active" } },
    User: { coll: "users", idField: "UserID", counter: "UserID", prefix: "USR", def: { Status: "Pending", Role: "Pending" } },
    HPProduction: { coll: "hpProduction", idField: "ProdID", counter: "HPProdID", prefix: "HPP" },
    HPSale: { coll: "hpSales", idField: "SaleID", counter: "HPSaleID", prefix: "HPS" },
    HPCashbook: { coll: "hpCashbook", idField: "EntryID", counter: "HPCashID", prefix: "HPC" },
    HPMistri: { coll: "hpMistri", idField: "MistriID", counter: "HPMistriID", prefix: "HPM", def: { Status: "Active" } },
    HPMistriPayment: { coll: "hpMistriPayments", idField: "PaymentID", counter: "HPMistriPayID", prefix: "HPMP" },
    HPMaterialPurchase: { coll: "hpMaterialPurchases", idField: "PurchaseID", counter: "HPMatPurchID", prefix: "HPMPU" },
    HPMaterialSale: { coll: "hpMaterialSales", idField: "MatSaleID", counter: "HPMatSaleID", prefix: "HPMS" }
  };
  const HP_MATERIALS = ["Cement", "Rod", "Sand", "Chips", "Binding Wire", "Liquid", "Emulsion", "Bitumin Drums", "Others"];
  const HP_SELLABLE_MATERIALS = ["Emulsion", "Bitumin Drums"];
  const HP_CATEGORIES = ["300mm", "450mm", "600mm", "900mm", "1000mm", "GP", "KM Stone", "200M Stone"];
  const HP_INCH_FACTOR = { "300mm": 12, "450mm": 18, "600mm": 24, "900mm": 36, "1000mm": 40, "GP": 0, "KM Stone": 0, "200M Stone": 0 };

  async function genericAdd(key, payload) {
    const m = MAP[key];
    const id = await nextId(m.counter, m.prefix, m.coll);
    const rec = Object.assign({}, m.def, payload, { CreatedAt: new Date().toISOString() });
    rec[m.idField] = m.idField === "SLNo" ? Number(id.replace(m.prefix, "")) : id;
    await db.collection(m.coll).doc(String(rec[m.idField])).set(rec);
    return { rec: rec, id: rec[m.idField] };
  }
  async function genericUpdate(key, payload, fields) {
    const m = MAP[key];
    const idVal = payload[m.idField];
    if (idVal === undefined || idVal === null || idVal === "") return false;
    const ref = db.collection(m.coll).doc(String(idVal));
    const snap = await ref.get();
    if (!snap.exists) {
      // fallback: doc ID drifted from the record's id field (older migrated rows) — find by field match.
      const q = await db.collection(m.coll).where(m.idField, "==", idVal).limit(1).get();
      if (q.empty) return false;
      await q.docs[0].ref.set(fields, { merge: true });
      return true;
    }
    await ref.set(fields, { merge: true });
    return true;
  }
  async function genericDelete(key, idValue) {
    const m = MAP[key];
    if (idValue === undefined || idValue === null || idValue === "") return;
    const ref = db.collection(m.coll).doc(String(idValue));
    const snap = await ref.get();
    if (snap.exists) { await ref.delete(); return; }
    const q = await db.collection(m.coll).where(m.idField, "==", idValue).limit(1).get();
    if (!q.empty) await q.docs[0].ref.delete();
  }

  function computeLabourNet(p) {
    const additional = Number(p.AdditionalAmount) || 0;
    const fare = Number(p.Fare) || 0;
    if (String(p.Type) === "Contract") return (Number(p.WorkMeter) || 0) * (Number(p.Price) || 0) + additional + fare;
    return (Number(p.DailyPrice) || 0) * (Number(p.HowManyLabour) || 0) + additional + fare;
  }

  async function computeUserBalance(walletUserName) {
    const [fundTransfers, siteAllocations, driverAllocations, payments, dieselPayments, staffPayments, mistriPayments, mistriAdvances, labourPayments, labourAdvances, otherPayments] = await Promise.all([
      colToArray("fundTransfers"), colToArray("siteAllocations"), colToArray("driverAllocations"), colToArray("payments"), colToArray("dieselPayments"),
      colToArray("staffPayments"), colToArray("mistriPayments"), colToArray("mistriAdvances"), colToArray("labourPayments"), colToArray("labourAdvances"), colToArray("otherPayments")
    ]);
    const sumBy = function (arr, field, matchFn) { return arr.filter(matchFn).reduce(function (a, r) { return a + (Number(r[field]) || 0); }, 0); };
    const byWallet = function (fallbackField) { return function (r) { return (r.WalletUser || r[fallbackField]) === walletUserName; }; };
    const received = sumBy(fundTransfers, "Amount", function (t) { return t.To === walletUserName; });
    const sentOut = sumBy(fundTransfers, "Amount", function (t) { return t.From === walletUserName; });
    const toSite = sumBy(siteAllocations, "Amount", byWallet("User"));
    const toDriver = sumBy(driverAllocations, "Amount", byWallet("User"));
    const toSupplier = sumBy(payments, "AmountPaid", byWallet("CreatedBy"));
    const toDiesel = sumBy(dieselPayments, "AmountPaid", byWallet("CreatedBy"));
    const toStaff = sumBy(staffPayments, "AmountPaid", byWallet("CreatedBy"));
    const toMistri = sumBy(mistriPayments, "AmountPaid", byWallet("CreatedBy")) + sumBy(mistriAdvances, "Amount", byWallet("From"));
    const toLabour = sumBy(labourPayments, "AmountPaid", byWallet("CreatedBy")) + sumBy(labourAdvances, "Amount", byWallet("From"));
    const toOther = sumBy(otherPayments, "Amount", byWallet("From"));
    return received - sentOut - toSite - toDriver - toSupplier - toDiesel - toStaff - toMistri - toLabour - toOther;
  }

  async function checkMoneySpend(requesterName, walletUserName, amount) {
    const users = await colToArray("users");
    const req = users.find(function (x) { return x.Name === requesterName; });
    if (req && req.Role !== "Owner" && req.MoneyEnabled === false) return { ok: false, message: "You don't have permission to send money yet. Ask Hrushikesh Padhi to enable it." };
    const wu = users.find(function (x) { return x.Name === walletUserName; });
    if (wu && wu.Role === "Owner") return { ok: true };
    const balance = await computeUserBalance(walletUserName);
    if (Number(amount) > balance) return { ok: false, message: "Insufficient balance in " + walletUserName + "'s wallet (available \u20b9" + Math.round(balance) + ")." };
    return { ok: true };
  }

  async function getSettingsMap() {
    const snap = await db.collection("settings").get();
    const map = {};
    snap.docs.forEach(function (d) { map[d.id] = d.data().Value; });
    return map;
  }
  async function setSettingValue(key, value) {
    await db.collection("settings").doc(key).set({ Value: value }, { merge: true });
  }
  async function getMaintenanceStatus() {
    const st = await getSettingsMap();
    return { enabled: String(st.MaintenanceMode) === "TRUE", message: st.MaintenanceMessage || "" };
  }
  async function getAnnouncementStatus() {
    const st = await getSettingsMap();
    return { enabled: String(st.AnnouncementEnabled) === "TRUE", message: st.AnnouncementMessage || "" };
  }

  async function route(action, p) {
    p = p || {};
    switch (action) {
      case "login": {
        const users = await colToArray("users");
        const u = users.find(function (x) { return String(x.Name).toLowerCase() === String(p.name || "").toLowerCase(); });
        if (!u) return { success: false, message: "Invalid name or password." };
        if (u.Status === "Pending") return { success: false, message: "Your account is awaiting approval from Hrushikesh Padhi." };
        if (u.Status !== "Active") return { success: false, message: "This account is not active. Contact Admin." };
        const pass = u.Password || USER_PASSWORDS[u.Name];
        if (pass && String(p.password) === String(pass)) {
          await db.collection("users").doc(u.UserID).set({ LastLogin: new Date().toISOString() }, { merge: true });
          return { success: true, user: { name: u.Name, role: u.Role }, maintenance: await getMaintenanceStatus(), announcement: await getAnnouncementStatus() };
        }
        return { success: false, message: "Invalid name or password." };
      }
      case "setMaintenance": {
        const users = await colToArray("users");
        const requester = users.find(function (x) { return String(x.Name).toLowerCase() === String(p.RequestedBy || "").toLowerCase(); });
        if (!requester || requester.Role !== "Admin 1") return { success: false, message: "Only Admin 1 can change maintenance mode." };
        await setSettingValue("MaintenanceMode", p.Enabled ? "TRUE" : "FALSE");
        if (p.Message !== undefined) await setSettingValue("MaintenanceMessage", p.Message);
        await auditLog(p.RequestedBy, p.Enabled ? "Enabled Maintenance Mode" : "Disabled Maintenance Mode", "Settings", "", p.Message || "");
        return { success: true, message: "Maintenance settings updated.", maintenance: await getMaintenanceStatus() };
      }
      case "setAnnouncement": {
        const users2 = await colToArray("users");
        const requester2 = users2.find(function (x) { return String(x.Name).toLowerCase() === String(p.RequestedBy || "").toLowerCase(); });
        if (!requester2 || requester2.Role !== "Admin 1") return { success: false, message: "Only Admin 1 can change the announcement." };
        await setSettingValue("AnnouncementEnabled", p.Enabled ? "TRUE" : "FALSE");
        if (p.Message !== undefined) await setSettingValue("AnnouncementMessage", p.Message);
        await auditLog(p.RequestedBy, p.Enabled ? "Enabled Announcement" : "Disabled Announcement", "Settings", "", p.Message || "");
        return { success: true, message: "Announcement updated.", announcement: await getAnnouncementStatus() };
      }
      case "getCollection": return { success: true, data: await colToArray(p.name) };
      // One-time, automatic, silent cleanup for the bad BF rows the old (pre-fix) auto-rollover
      // wrote. Runs itself at most once ever (guarded by a meta flag) \u2014 no button, no admin
      // action, nothing to click by mistake. Deletes only System-created rows for the month it
      // ran in; BF display no longer depends on any auto-written row going forward (see below).
      // Runs every login and removes any System-created BF row for the current month \u2014 cheap
      // (a handful of small reads) and harmless once nothing matches. No new rows are written
      // automatically anymore, so after the existing bad rows are gone this becomes a no-op.
      // One-time-per-row fill: any BF row for August with no BFDate gets dated to the last day
      // of August, so the "since this date" purchase/due/payment scoping actually has a cutoff
      // instead of silently counting all history.
      case "autoMaintenanceCheck": {
        // Combines the seed/fill/cleanup one-time-ish maintenance actions into a single round
        // trip (cheap either way, but 1 call beats 4 sequential ones), and is only invoked by
        // the client once per calendar day per browser \u2014 not on every login \u2014 to keep this
        // off the hot path entirely most of the time.
        let seeded = 0, filled = 0, removed = 0, rolled = 0;
        {
          const flagRef3 = db.collection("meta").doc("personBFSeed");
          const flagDoc3 = await flagRef3.get();
          if (!(flagDoc3.exists && flagDoc3.data().done)) {
            const seedList = [["staff", "staffBF", "StaffBFID", "SBF"], ["labour", "labourBF", "LabourBFID", "LBF"], ["mistri", "mistriBF", "MistriBFID", "MBF"]];
            for (const [srcColl, bfColl, counter, prefix] of seedList) {
              const [people, existingBF] = await Promise.all([colToArray(srcColl), colToArray(bfColl)]);
              const namesWithBF = new Set(existingBF.map(function (r) { return r.Name; }));
              for (const person of people) {
                if (namesWithBF.has(person.Name)) continue;
                const amt = Number(person.BFAmount) || 0;
                if (!amt) continue;
                const id = await nextId(counter, prefix, bfColl);
                await db.collection(bfColl).doc(id).set({ BFID: id, Name: person.Name, BFMonth: "August", BFDate: "2026-08-31", BFAmount: amt, Remarks: "", CreatedBy: "System", CreatedAt: new Date().toISOString() });
                seeded++;
              }
            }
            await flagRef3.set({ done: true, seeded: seeded, ranAt: new Date().toISOString() }, { merge: true });
          }
        }
        {
          const flagRef4 = db.collection("meta").doc("augustBFDateFill");
          const flagDoc4 = await flagRef4.get();
          if (!(flagDoc4.exists && flagDoc4.data().done)) {
            for (const coll of ["bf", "dieselBF", "staffBF", "labourBF", "mistriBF"]) {
              const snap2 = await db.collection(coll).get();
              for (const doc of snap2.docs) {
                const dd = doc.data();
                const hasDate = dd.BFDate !== undefined && dd.BFDate !== null && String(dd.BFDate).trim() !== "";
                if (!hasDate && String(dd.BFMonth || "").toLowerCase().indexOf("august") !== -1) { await doc.ref.set({ BFDate: "2026-08-31" }, { merge: true }); filled++; }
              }
            }
            await flagRef4.set({ done: true, filled: filled, ranAt: new Date().toISOString() }, { merge: true });
          }
        }
        {
          const nowC = new Date();
          const monthKeyC = nowC.toISOString().slice(0, 7);
          for (const coll of ["bf", "dieselBF", "staffBF", "labourBF", "mistriBF"]) {
            const snap = await db.collection(coll).where("CreatedBy", "==", "System").get();
            for (const doc of snap.docs) {
              const dd = doc.data();
              if (dd.BFMonth && monthKeyOfLabel(dd.BFMonth) === monthKeyC) { await doc.ref.delete(); removed++; }
            }
          }
        }
        return { success: true, seeded: seeded, filled: filled, removed: removed };
      }
      case "autoSeedPersonBF": {
        const flagRef3 = db.collection("meta").doc("personBFSeed");
        const flagDoc3 = await flagRef3.get();
        if (flagDoc3.exists && flagDoc3.data().done) return { success: true, skipped: true };
        let seeded = 0;
        const seedList = [["staff", "staffBF", "StaffBFID", "SBF"], ["labour", "labourBF", "LabourBFID", "LBF"], ["mistri", "mistriBF", "MistriBFID", "MBF"]];
        for (const [srcColl, bfColl, counter, prefix] of seedList) {
          const [people, existingBF] = await Promise.all([colToArray(srcColl), colToArray(bfColl)]);
          const namesWithBF = new Set(existingBF.map(function (r) { return r.Name; }));
          for (const person of people) {
            if (namesWithBF.has(person.Name)) continue;
            const amt = Number(person.BFAmount) || 0;
            if (!amt) continue;
            const id = await nextId(counter, prefix, bfColl);
            await db.collection(bfColl).doc(id).set({ BFID: id, Name: person.Name, BFMonth: "August", BFDate: "2026-08-31", BFAmount: amt, Remarks: "", CreatedBy: "System", CreatedAt: new Date().toISOString() });
            seeded++;
          }
        }
        await flagRef3.set({ done: true, seeded: seeded, ranAt: new Date().toISOString() }, { merge: true });
        return { success: true, seeded: seeded };
      }
      case "autoFillAugustBFDates": {
        const flagRef2 = db.collection("meta").doc("augustBFDateFill");
        const flagDoc2 = await flagRef2.get();
        if (flagDoc2.exists && flagDoc2.data().done) return { success: true, skipped: true };
        let filled = 0;
        for (const coll of ["bf", "dieselBF", "staffBF", "labourBF", "mistriBF"]) {
          const snap2 = await db.collection(coll).get();
          for (const doc of snap2.docs) {
            const d = doc.data();
            const hasDate = d.BFDate !== undefined && d.BFDate !== null && String(d.BFDate).trim() !== "";
            if (!hasDate && String(d.BFMonth || "").toLowerCase().indexOf("august") !== -1) { await doc.ref.set({ BFDate: "2026-08-31" }, { merge: true }); filled++; }
          }
        }
        await flagRef2.set({ done: true, filled: filled, ranAt: new Date().toISOString() }, { merge: true });
        return { success: true, filled: filled };
      }
      case "autoCleanupBadRollover": {
        const now2 = new Date();
        const monthKey2 = now2.toISOString().slice(0, 7);
        let removed = 0;
        for (const coll of ["bf", "dieselBF", "staffBF", "labourBF", "mistriBF"]) {
          const snap = await db.collection(coll).where("CreatedBy", "==", "System").get();
          for (const doc of snap.docs) {
            const d = doc.data();
            if (d.BFMonth && monthKeyOfLabel(d.BFMonth) === monthKey2) { await doc.ref.delete(); removed++; }
          }
        }
        return { success: true, skipped: false, removed: removed };
      }
      case "runMonthlyRollover": {
        const now = new Date();
        const monthKey = now.toISOString().slice(0, 7);
        const settingsRef = db.collection("meta").doc("monthlyRollover");
        const existingDoc = await settingsRef.get();
        const lastRunMonth = existingDoc.exists ? existingDoc.data().lastRunMonth : null;
        // Skips entirely once this month's rollover has run \u2014 this is the expensive action
        // (reads every supplier/staff/labour/mistri's transactions), so it must stay a once-a-
        // month cost, not a per-login one, to protect the read quota that started this thread.
        if (lastRunMonth === monthKey) return { success: true, skipped: true, message: "Already rolled over for this month." };
        await settingsRef.set({ lastRunMonth: monthKey, ranAt: now.toISOString() }, { merge: true });
        const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const bfDateStr = monthKey + "-01";
        // Picks the entry for a name whose BFMonth is the furthest along (month-key, not raw
        // BFDate string) \u2014 fixes rollovers/detail pages picking a stale/duplicate BF row.
        const latestBF = function (list, name, field) {
          const rows = list.filter(function (r) { return r[field] === name; });
          const row = pickLatestBFRow(rows);
          return row ? { amt: Number(row.BFAmount) || 0, date: row.BFDate || "", month: row.BFMonth || "" } : { amt: 0, date: "", month: "" };
        };
        const [suppliers, transactions, payments, bf, dieselTx, dieselPayments, dieselBF,
          staff, staffSalary, staffPayments, staffBF,
          labour, labourEntries, labourPayments, labourAdvances, labourBF,
          mistri, mistriDue, mistriPayments, mistriAdvances, mistriBF] = await Promise.all(
          ["suppliers", "transactions", "payments", "bf", "dieselTx", "dieselPayments", "dieselBF",
            "staff", "staffSalary", "staffPayments", "staffBF",
            "labour", "labourEntries", "labourPayments", "labourAdvances", "labourBF",
            "mistri", "mistriDue", "mistriPayments", "mistriAdvances", "mistriBF"].map(colToArray)
        );
        let rolled = 0;
        for (const sup of suppliers) {
          const name = sup.SupplierName;
          const { amt: bfAmt, date: bfDate, month: bfMonth } = latestBF(bf, name, "Supplier");
          if (monthKeyOfLabel(bfMonth) === monthKey) continue; // already rolled this month
          const purchase = transactions.filter(function (t) { return t.Supplier === name && (!bfDate || t.Date > bfDate); }).reduce(function (a, t) { return a + (Number(t.Value) || 0); }, 0);
          const paid = payments.filter(function (p2) { return p2.Supplier === name && (!bfDate || p2.Date > bfDate); }).reduce(function (a, p2) { return a + (Number(p2.AmountPaid) || 0); }, 0);
          const outstanding = bfAmt + purchase - paid;
          const id = await nextId("BF", "BF", "bf");
          await db.collection("bf").doc(id).set({ BFID: id, Supplier: name, BFMonth: monthLabel, BFDate: bfDateStr, BFAmount: outstanding, Site: "", Remarks: "Auto month-end rollover", CreatedBy: "System", CreatedAt: now.toISOString() });
          rolled++;
        }
        const dieselNames = Array.from(new Set(dieselTx.map(function (t) { return t.Supplier; }).concat(dieselBF.map(function (b) { return b.Supplier; })).filter(Boolean)));
        for (const name of dieselNames) {
          const { amt: bfAmt, date: bfDate, month: bfMonth } = latestBF(dieselBF, name, "Supplier");
          if (monthKeyOfLabel(bfMonth) === monthKey) continue;
          const cost = dieselTx.filter(function (t) { return t.Supplier === name && (!bfDate || t.Date > bfDate); }).reduce(function (a, t) { return a + (Number(t.Value) || 0); }, 0);
          const paid = dieselPayments.filter(function (p2) { return p2.Supplier === name && (!bfDate || p2.Date > bfDate); }).reduce(function (a, p2) { return a + (Number(p2.AmountPaid) || 0); }, 0);
          const outstanding = bfAmt + cost - paid;
          const id = await nextId("DieselBF", "DBF", "dieselBF");
          await db.collection("dieselBF").doc(id).set({ DieselBFID: id, Supplier: name, BFMonth: monthLabel, BFDate: bfDateStr, BFAmount: outstanding, Site: "", Remarks: "Auto month-end rollover", CreatedBy: "System", CreatedAt: now.toISOString() });
          rolled++;
        }
        // Staff / Labour / Mistri: same monthly-BF pattern as suppliers. If a name has no BF
        // history yet, its existing single BFAmount field is the opening balance (bfDate ""
        // means "count all history since forever", matching what the app already showed).
        const rollPeople = async function (list, dueList, dueField, dueNameField, payList, advList, bfList, bfAddAction, bfColl, bfCounter, bfPrefix) {
          for (const person of list) {
            const name = person.Name;
            const existing = bfList.filter(function (r) { return r.Name === name; });
            let bfAmt, bfDate, bfMonth;
            if (existing.length) {
              const row = pickLatestBFRow(existing);
              bfAmt = Number(row.BFAmount) || 0; bfDate = row.BFDate || ""; bfMonth = row.BFMonth || "";
            } else {
              bfAmt = Number(person.BFAmount) || 0; bfDate = ""; bfMonth = "";
            }
            if (monthKeyOfLabel(bfMonth) === monthKey) continue;
            const due = dueList.filter(function (r) { return r[dueNameField] === name && (!bfDate || (r.Date || r.Month + "-01") > bfDate); }).reduce(function (a, r) { return a + (Number(r[dueField]) || 0); }, 0);
            const advances = (advList || []).filter(function (r) { return r[dueNameField] === name && (!bfDate || r.Date > bfDate); }).reduce(function (a, r) { return a + (Number(r.Amount) || 0); }, 0);
            const paid = payList.filter(function (r) { return r[dueNameField] === name && (!bfDate || r.Date > bfDate); }).reduce(function (a, r) { return a + (Number(r.AmountPaid) || 0); }, 0);
            const outstanding = bfAmt + due + advances - paid;
            const id = await nextId(bfCounter, bfPrefix, bfColl);
            await db.collection(bfColl).doc(id).set({ BFID: id, Name: name, BFMonth: monthLabel, BFDate: bfDateStr, BFAmount: outstanding, Remarks: "Auto month-end rollover", CreatedBy: "System", CreatedAt: now.toISOString() });
            rolled++;
          }
        };
        await rollPeople(staff, staffSalary, "NetSalary", "StaffName", staffPayments, null, staffBF, "addStaffBF", "staffBF", "StaffBFID", "SBF");
        await rollPeople(labour, labourEntries, "NetAmount", "LabourName", labourPayments, labourAdvances, labourBF, "addLabourBF", "labourBF", "LabourBFID", "LBF");
        await rollPeople(mistri, mistriDue, "NetDue", "MistriName", mistriPayments, mistriAdvances, mistriBF, "addMistriBF", "mistriBF", "MistriBFID", "MBF");
        return { success: true, skipped: false, rolled: rolled, message: "Monthly rollover complete (" + rolled + " BF entries added)." };
      }
      case "getAllData": {
        const names = ["suppliers", "transactions", "payments", "bf", "dieselTx", "dieselPayments", "dieselBF", "sites", "materials", "users", "staff", "staffSalary", "staffPayments", "fundTransfers", "siteAllocations", "siteExpenses", "siteTransfers", "otherPayments", "staffAttendance", "mistri", "mistriDue", "mistriPayments", "mistriAdvances", "labour", "labourEntries", "labourPayments", "labourAdvances", "taskCompletions", "staffBF", "labourBF", "mistriBF", "vehicles", "vehicleDailyLog", "cementReceived", "cementUsed", "driverAllocations", "duplicateReviews"];
        const dateFilteredNames = ["transactions", "payments", "dieselTx", "dieselPayments", "siteExpenses", "siteTransfers", "staffPayments", "mistriPayments", "mistriAdvances", "labourPayments", "labourAdvances", "otherPayments", "fundTransfers", "siteAllocations", "vehicleDailyLog", "cementReceived", "cementUsed", "staffAttendance", "labourEntries", "driverAllocations"];
        const cutoff = await computeLoadCutoff();
        const arrs = await Promise.all(names.map(function (n) { return dateFilteredNames.indexOf(n) !== -1 ? colToArraySince(n, cutoff) : colToArray(n); }));
        const out = { success: true };
        names.forEach(function (n, i) { out[n] = arrs[i]; });
        if (p.user) {
          const usersArr = out.users || [];
          const u2 = usersArr.find(function (x) { return String(x.Name).toLowerCase() === String(p.user).toLowerCase(); });
          if (u2) {
            const nowIso = new Date().toISOString();
            u2.LastRefresh = nowIso;
            db.collection("users").doc(u2.UserID).set({ LastRefresh: nowIso }, { merge: true }).catch(function () {});
          }
        }
        out.auditLog = []; // fetched separately via getAuditLog only when the Settings/Audit tab is opened
        out.maintenance = await getMaintenanceStatus();
        out.announcement = await getAnnouncementStatus();
        return out;
      }
      case "getUsers": return { success: true, data: await colToArray("users") };
      case "getDateRange": {
        const rangeNames = Array.isArray(p.names) ? p.names : [];
        const arrs = await Promise.all(rangeNames.map(function (n) {
          return db.collection(n).where("Date", ">=", p.from).where("Date", "<=", p.to).get().then(function (snap) { return snap.docs.map(function (d) { return d.data(); }); });
        }));
        const out = { success: true, data: {} };
        rangeNames.forEach(function (n, i) { out.data[n] = arrs[i]; });
        return out;
      }
      case "getAuditLog": { const s = await db.collection("auditLog").orderBy("Timestamp", "desc").get(); return { success: true, data: s.docs.map(function (d) { return d.data(); }) }; }
      case "updateUserContact": {
        const users = await colToArray("users");
        const u = users.find(function (x) { return x.Name === p.Name; });
        if (!u) return { success: false, message: "User not found." };
        await db.collection("users").doc(u.UserID).set({ ContactNumber: p.ContactNumber }, { merge: true });
        await auditLog(p.CreatedBy, "Updated User Contact", "Users", p.Name, p.ContactNumber);
        return { success: true, message: "Contact number updated successfully." };
      }

      case "getSuppliers": return { success: true, data: await colToArray("suppliers") };
      case "addSupplier": { const r = await genericAdd("Supplier", { SupplierName: p.SupplierName, ContactPerson: p.ContactPerson, ContactNumber: p.ContactNumber, MaterialType: p.MaterialType }); await auditLog(p.CreatedBy, "Added Supplier", "Suppliers", r.id, p.SupplierName); return { success: true, message: "Supplier saved successfully." }; }
      case "updateSupplier": { const ok = await genericUpdate("Supplier", p, { SupplierName: p.SupplierName, ContactPerson: p.ContactPerson, ContactNumber: p.ContactNumber, MaterialType: p.MaterialType }); if (!ok) return { success: false, message: "Supplier not found." }; await auditLog(p.CreatedBy, "Updated Supplier", "Suppliers", p.SupplierID, p.SupplierName); return { success: true, message: "Supplier updated successfully." }; }
      case "deleteSupplier": await genericDelete("Supplier", p.SupplierID); await auditLog(p.CreatedBy, "Deleted Supplier", "Suppliers", p.SupplierID, p.SupplierName || ""); return { success: true, message: "Supplier deleted successfully." };

      case "getTransactions": return { success: true, data: await colToArray("transactions") };
      case "addTransaction": { const fare = Number(p.Fare) || 0; const fareType = p.FareType === "Self" ? "Self" : "Supplier"; const materialAmount = Number(p.Quantity) * Number(p.Rate); const fareAmount = Number(p.Quantity) * fare; const value = materialAmount + (fareType === "Self" ? 0 : fareAmount); const r = await genericAdd("Transaction", { Date: p.Date, Time: p.Time || "", Supplier: p.Supplier, VehicleNumber: p.VehicleNumber, Material: p.Material, Quantity: p.Quantity, Unit: p.Unit, Rate: p.Rate, Fare: fare, FareType: fareType, MaterialAmount: materialAmount, FareAmount: fareAmount, Value: value, Site: p.Site, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Supplier Transaction", "SupplierTransactions", r.id, p.Supplier + " ₹" + value); return { success: true, message: "Transaction saved successfully.", data: { Value: value } }; }
      case "updateTransaction": { const fare = Number(p.Fare) || 0; const fareType = p.FareType === "Self" ? "Self" : "Supplier"; const materialAmount = Number(p.Quantity) * Number(p.Rate); const fareAmount = Number(p.Quantity) * fare; const value = materialAmount + (fareType === "Self" ? 0 : fareAmount); const ok = await genericUpdate("Transaction", { SLNo: p.SLNo }, { Date: p.Date, Time: p.Time || "", Supplier: p.Supplier, VehicleNumber: p.VehicleNumber, Material: p.Material, Quantity: p.Quantity, Unit: p.Unit, Rate: p.Rate, Fare: fare, FareType: fareType, MaterialAmount: materialAmount, FareAmount: fareAmount, Value: value, Site: p.Site, Remarks: p.Remarks }); if (!ok) return { success: false, message: "Transaction not found." }; await auditLog(p.CreatedBy, "Updated Supplier Transaction", "SupplierTransactions", p.SLNo, p.Supplier + " ₹" + value); return { success: true, message: "Transaction updated successfully." }; }
      case "deleteTransaction": await genericDelete("Transaction", p.SLNo); await auditLog(p.CreatedBy, "Deleted Transaction", "SupplierTransactions", p.SLNo, ""); return { success: true, message: "Transaction deleted successfully." };

      case "getPayments": return { success: true, data: await colToArray("payments") };
      case "addPayment": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.AmountPaid); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("Payment", { Date: p.Date, Supplier: p.Supplier, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber || "", Site: p.Site || "", Remarks: p.Remarks || "", WalletUser: "Sukadev", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Supplier Payment", "SupplierPayments", r.id, p.Supplier + " ₹" + p.AmountPaid); return { success: true, message: "Payment saved successfully." }; }
      case "updatePayment": { const ok = await genericUpdate("Payment", p, { Date: p.Date, Supplier: p.Supplier, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber, Site: p.Site || "", Remarks: p.Remarks, WalletUser: "Sukadev" }); if (!ok) return { success: false, message: "Payment not found." }; await auditLog(p.CreatedBy, "Updated Supplier Payment", "SupplierPayments", p.PaymentID, p.Supplier + " ₹" + p.AmountPaid); return { success: true, message: "Payment updated successfully." }; }
      case "deletePayment": await genericDelete("Payment", p.PaymentID); await auditLog(p.CreatedBy, "Deleted Payment", "SupplierPayments", p.PaymentID, ""); return { success: true, message: "Payment deleted successfully." };

      case "getBF": return { success: true, data: await colToArray("bf") };
      case "addBF": { const id = (await nextId("BF", "BF")); const rec = { Supplier: p.Supplier, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Site: p.Site, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "", CreatedAt: new Date().toISOString() }; await db.collection("bf").doc(id).set(rec); await auditLog(p.CreatedBy, "Updated Supplier BF", "SupplierBF", p.Supplier, "₹" + p.BFAmount); return { success: true, message: "BF balance saved successfully." }; }
      case "updateBF": { const arr = await colToArray("bf"); const rec = arr.find(function (x) { return x.Supplier === p.OrigSupplier && x.BFMonth === p.OrigBFMonth && x.BFDate === p.OrigBFDate; }); if (!rec) return { success: false, message: "BF entry not found." }; const snap = await db.collection("bf").where("Supplier", "==", p.OrigSupplier).where("BFMonth", "==", p.OrigBFMonth).where("BFDate", "==", p.OrigBFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.set({ Supplier: p.Supplier, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Site: p.Site, Remarks: p.Remarks }, { merge: true }); await auditLog(p.CreatedBy, "Updated Supplier BF", "SupplierBF", p.Supplier, "₹" + p.BFAmount); return { success: true, message: "BF balance updated successfully." }; }
      case "deleteBF": { const snap = await db.collection("bf").where("Supplier", "==", p.Supplier).where("BFMonth", "==", p.BFMonth).where("BFDate", "==", p.BFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.delete(); await auditLog(p.CreatedBy, "Deleted BF Entry", "SupplierBF", p.Supplier, ""); return { success: true, message: "BF entry deleted successfully." }; }

      case "getStaffBF": return { success: true, data: await colToArray("staffBF") };
      case "addStaffBF": { const id = (await nextId("StaffBFID", "SBF")); const rec = { Name: p.Name, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "", CreatedAt: new Date().toISOString() }; await db.collection("staffBF").doc(id).set(rec); await auditLog(p.CreatedBy, "Added Staff BF", "StaffBF", p.Name, "\u20B9" + p.BFAmount); return { success: true, message: "BF balance saved successfully." }; }
      case "updateStaffBF": { const snap = await db.collection("staffBF").where("Name", "==", p.OrigName).where("BFMonth", "==", p.OrigBFMonth).where("BFDate", "==", p.OrigBFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.set({ Name: p.Name, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Remarks: p.Remarks }, { merge: true }); await auditLog(p.CreatedBy, "Updated Staff BF", "StaffBF", p.Name, "\u20B9" + p.BFAmount); return { success: true, message: "BF balance updated successfully." }; }
      case "deleteStaffBF": { const snap = await db.collection("staffBF").where("Name", "==", p.Name).where("BFMonth", "==", p.BFMonth).where("BFDate", "==", p.BFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.delete(); await auditLog(p.CreatedBy, "Deleted BF Entry", "StaffBF", p.Name, ""); return { success: true, message: "BF entry deleted successfully." }; }

      case "getLabourBF": return { success: true, data: await colToArray("labourBF") };
      case "addLabourBF": { const id = (await nextId("LabourBFID", "LBF")); const rec = { Name: p.Name, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "", CreatedAt: new Date().toISOString() }; await db.collection("labourBF").doc(id).set(rec); await auditLog(p.CreatedBy, "Added Labour BF", "LabourBF", p.Name, "\u20B9" + p.BFAmount); return { success: true, message: "BF balance saved successfully." }; }
      case "updateLabourBF": { const snap = await db.collection("labourBF").where("Name", "==", p.OrigName).where("BFMonth", "==", p.OrigBFMonth).where("BFDate", "==", p.OrigBFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.set({ Name: p.Name, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Remarks: p.Remarks }, { merge: true }); await auditLog(p.CreatedBy, "Updated Labour BF", "LabourBF", p.Name, "\u20B9" + p.BFAmount); return { success: true, message: "BF balance updated successfully." }; }
      case "deleteLabourBF": { const snap = await db.collection("labourBF").where("Name", "==", p.Name).where("BFMonth", "==", p.BFMonth).where("BFDate", "==", p.BFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.delete(); await auditLog(p.CreatedBy, "Deleted BF Entry", "LabourBF", p.Name, ""); return { success: true, message: "BF entry deleted successfully." }; }

      case "getMistriBF": return { success: true, data: await colToArray("mistriBF") };
      case "addMistriBF": { const id = (await nextId("MistriBFID", "MBF")); const rec = { Name: p.Name, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "", CreatedAt: new Date().toISOString() }; await db.collection("mistriBF").doc(id).set(rec); await auditLog(p.CreatedBy, "Added Mistri BF", "MistriBF", p.Name, "\u20B9" + p.BFAmount); return { success: true, message: "BF balance saved successfully." }; }
      case "updateMistriBF": { const snap = await db.collection("mistriBF").where("Name", "==", p.OrigName).where("BFMonth", "==", p.OrigBFMonth).where("BFDate", "==", p.OrigBFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.set({ Name: p.Name, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Remarks: p.Remarks }, { merge: true }); await auditLog(p.CreatedBy, "Updated Mistri BF", "MistriBF", p.Name, "\u20B9" + p.BFAmount); return { success: true, message: "BF balance updated successfully." }; }
      case "deleteMistriBF": { const snap = await db.collection("mistriBF").where("Name", "==", p.Name).where("BFMonth", "==", p.BFMonth).where("BFDate", "==", p.BFDate).get(); if (snap.empty) return { success: false, message: "BF entry not found." }; await snap.docs[0].ref.delete(); await auditLog(p.CreatedBy, "Deleted BF Entry", "MistriBF", p.Name, ""); return { success: true, message: "BF entry deleted successfully." }; }

      case "getDieselTransactions": return { success: true, data: await colToArray("dieselTx") };
      case "addDieselTransaction": { const value = Number(p.DieselQuantity) * Number(p.Rate); const r = await genericAdd("DieselTransaction", { Date: p.Date, ChalanNumber: p.ChalanNumber || "", Time: p.Time || "", Supplier: p.Supplier, VehicleNumber: p.VehicleNumber || "", DieselQuantity: p.DieselQuantity, Unit: p.Unit || "Litres", Rate: p.Rate, Value: value, Site: p.Site || "", VehicleSite: p.VehicleSite || "", PersonName: p.PersonName || "", Driver: p.Driver || "", Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Diesel Transaction", "DieselTransactions", r.id, p.Supplier + " ₹" + value); return { success: true, message: "Diesel transaction saved successfully.", data: { Value: value } }; }
      case "updateDieselTransaction": { const value = Number(p.DieselQuantity) * Number(p.Rate); const ok = await genericUpdate("DieselTransaction", { SLNo: p.SLNo }, { Date: p.Date, ChalanNumber: p.ChalanNumber || "", Time: p.Time || "", Supplier: p.Supplier, VehicleNumber: p.VehicleNumber || "", DieselQuantity: p.DieselQuantity, Rate: p.Rate, Value: value, Site: p.Site || "", VehicleSite: p.VehicleSite || "", PersonName: p.PersonName || "", Driver: p.Driver, Remarks: p.Remarks }); if (!ok) return { success: false, message: "Diesel transaction not found." }; await auditLog(p.CreatedBy, "Updated Diesel Transaction", "DieselTransactions", p.SLNo, p.Supplier + " ₹" + value); return { success: true, message: "Diesel transaction updated successfully." }; }
      case "deleteDieselTransaction": await genericDelete("DieselTransaction", p.SLNo); await auditLog(p.CreatedBy, "Deleted Diesel Transaction", "DieselTransactions", p.SLNo, ""); return { success: true, message: "Diesel transaction deleted successfully." };

      case "getDieselPayments": return { success: true, data: await colToArray("dieselPayments") };
      case "addDieselPayment": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.AmountPaid); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("DieselPayment", { Date: p.Date, Supplier: p.Supplier, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber || "", Site: p.Site || "", Remarks: p.Remarks || "", WalletUser: "Sukadev", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Diesel Payment", "DieselPayments", r.id, p.Supplier + " ₹" + p.AmountPaid); return { success: true, message: "Diesel payment saved successfully." }; }
      case "updateDieselPayment": { const ok = await genericUpdate("DieselPayment", p, { Date: p.Date, Supplier: p.Supplier, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber, Site: p.Site || "", Remarks: p.Remarks, WalletUser: "Sukadev" }); if (!ok) return { success: false, message: "Diesel payment not found." }; await auditLog(p.CreatedBy, "Updated Diesel Payment", "DieselPayments", p.PaymentID, p.Supplier + " ₹" + p.AmountPaid); return { success: true, message: "Diesel payment updated successfully." }; }
      case "deleteDieselPayment": await genericDelete("DieselPayment", p.PaymentID); await auditLog(p.CreatedBy, "Deleted Diesel Payment", "DieselPayments", p.PaymentID, ""); return { success: true, message: "Diesel payment deleted successfully." };

      case "getDieselBF": return { success: true, data: await colToArray("dieselBF") };
      case "addDieselBF": { const id = (await nextId("DieselBF", "DBF")); const rec = { Supplier: p.Supplier, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Site: p.Site, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "", CreatedAt: new Date().toISOString() }; await db.collection("dieselBF").doc(id).set(rec); await auditLog(p.CreatedBy, "Updated Diesel BF", "DieselBF", p.Supplier, "₹" + p.BFAmount); return { success: true, message: "Diesel BF saved successfully." }; }
      case "updateDieselBF": { const snap = await db.collection("dieselBF").where("Supplier", "==", p.OrigSupplier).where("BFMonth", "==", p.OrigBFMonth).where("BFDate", "==", p.OrigBFDate).get(); if (snap.empty) return { success: false, message: "Diesel BF entry not found." }; await snap.docs[0].ref.set({ Supplier: p.Supplier, BFMonth: p.BFMonth, BFDate: p.BFDate, BFAmount: p.BFAmount, Site: p.Site, Remarks: p.Remarks }, { merge: true }); await auditLog(p.CreatedBy, "Updated Diesel BF", "DieselBF", p.Supplier, "₹" + p.BFAmount); return { success: true, message: "Diesel BF updated successfully." }; }
      case "deleteDieselBF": { const snap = await db.collection("dieselBF").where("Supplier", "==", p.Supplier).where("BFMonth", "==", p.BFMonth).where("BFDate", "==", p.BFDate).get(); if (snap.empty) return { success: false, message: "Diesel BF entry not found." }; await snap.docs[0].ref.delete(); await auditLog(p.CreatedBy, "Deleted Diesel BF Entry", "DieselBF", p.Supplier, ""); return { success: true, message: "Diesel BF entry deleted successfully." }; }

      case "getSites": return { success: true, data: await colToArray("sites") };
      case "addSite": { const r = await genericAdd("Site", { SiteName: p.SiteName }); await auditLog(p.CreatedBy, "Added Site", "Sites", r.id, p.SiteName); return { success: true, message: "Site saved successfully." }; }
      case "updateSite": { const ok = await genericUpdate("Site", p, { SiteName: p.SiteName }); if (!ok) return { success: false, message: "Site not found." }; await auditLog(p.CreatedBy, "Updated Site", "Sites", p.SiteID, p.SiteName); return { success: true, message: "Site updated successfully." }; }
      case "deleteSite": await genericDelete("Site", p.SiteID); await auditLog(p.CreatedBy, "Deleted Site", "Sites", p.SiteID, ""); return { success: true, message: "Site deleted successfully." };

      case "getVehicles": return { success: true, data: await colToArray("vehicles") };
      case "addVehicle": { const r = await genericAdd("Vehicle", { VehicleNumber: p.VehicleNumber, DriverName: p.DriverName || "", VehicleType: p.VehicleType || "Truck", Mileage: p.Mileage || 0, HourlyRate: p.HourlyRate || 0, MonthlyRent: p.MonthlyRent || 0, DailyDriverFee: p.DailyDriverFee || 0, Notes: p.Notes || "" }); await auditLog(p.CreatedBy, "Added Vehicle", "Vehicles", r.id, p.VehicleNumber); return { success: true, message: "Vehicle saved successfully." }; }
      case "updateVehicle": { const ok = await genericUpdate("Vehicle", p, { VehicleNumber: p.VehicleNumber, DriverName: p.DriverName || "", VehicleType: p.VehicleType || "Truck", Mileage: p.Mileage || 0, HourlyRate: p.HourlyRate || 0, MonthlyRent: p.MonthlyRent || 0, DailyDriverFee: p.DailyDriverFee || 0, Notes: p.Notes || "" }); if (!ok) return { success: false, message: "Vehicle not found." }; await auditLog(p.CreatedBy, "Updated Vehicle", "Vehicles", p.VehicleID, p.VehicleNumber); return { success: true, message: "Vehicle updated successfully." }; }
      case "deleteVehicle": await genericDelete("Vehicle", p.VehicleID); await auditLog(p.CreatedBy, "Deleted Vehicle", "Vehicles", p.VehicleID, ""); return { success: true, message: "Vehicle deleted successfully." };

      case "getVehicleLogs": return { success: true, data: await colToArray("vehicleDailyLog") };
      case "addVehicleLog": { const r = await genericAdd("VehicleLog", { Date: p.Date, VehicleNumber: p.VehicleNumber, KmRun: Number(p.KmRun) || 0, HoursRun: Number(p.HoursRun) || 0, DriverFee: Number(p.DriverFee) || 0, Fooding: Number(p.Fooding) || 0, OtherExpense: Number(p.OtherExpense) || 0, OilPricePerLitre: Number(p.OilPricePerLitre) || 0, Remarks: p.Remarks || "" }); await auditLog(p.CreatedBy, "Added Vehicle Log", "VehicleLog", r.id, p.VehicleNumber); return { success: true, message: "Vehicle log saved successfully." }; }
      case "updateVehicleLog": { const ok = await genericUpdate("VehicleLog", p, { Date: p.Date, VehicleNumber: p.VehicleNumber, KmRun: Number(p.KmRun) || 0, HoursRun: Number(p.HoursRun) || 0, DriverFee: Number(p.DriverFee) || 0, Fooding: Number(p.Fooding) || 0, OtherExpense: Number(p.OtherExpense) || 0, OilPricePerLitre: Number(p.OilPricePerLitre) || 0, Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Vehicle log not found." }; await auditLog(p.CreatedBy, "Updated Vehicle Log", "VehicleLog", p.LogID, p.VehicleNumber); return { success: true, message: "Vehicle log updated successfully." }; }
      case "deleteVehicleLog": await genericDelete("VehicleLog", p.LogID); await auditLog(p.CreatedBy, "Deleted Vehicle Log", "VehicleLog", p.LogID, ""); return { success: true, message: "Vehicle log deleted successfully." };

      case "getMaterials": return { success: true, data: await colToArray("materials") };
      case "addMaterial": { const r = await genericAdd("Material", { MaterialName: p.MaterialName, DefaultUnit: p.DefaultUnit }); await auditLog(p.CreatedBy, "Added Material", "Materials", r.id, p.MaterialName); return { success: true, message: "Material saved successfully." }; }
      case "updateMaterial": { const ok = await genericUpdate("Material", p, { MaterialName: p.MaterialName, DefaultUnit: p.DefaultUnit }); if (!ok) return { success: false, message: "Material not found." }; await auditLog(p.CreatedBy, "Updated Material", "Materials", p.MaterialID, p.MaterialName); return { success: true, message: "Material updated successfully." }; }
      case "deleteMaterial": await genericDelete("Material", p.MaterialID); await auditLog(p.CreatedBy, "Deleted Material", "Materials", p.MaterialID, ""); return { success: true, message: "Material deleted successfully." };

      case "getStaff": return { success: true, data: await colToArray("staff") };
      case "addStaff": { const r = await genericAdd("Staff", { Name: p.Name, Role: p.Role, ContactNumber: p.ContactNumber, SalaryBasis: p.SalaryBasis, MonthlyAmount: p.MonthlyAmount || 0, DailyRate: p.DailyRate || 0, BFAmount: p.BFAmount || 0 }); await auditLog(p.CreatedBy, "Added Staff", "Staff", r.id, p.Name); return { success: true, message: "Staff saved successfully." }; }
      case "updateStaff": { const ok = await genericUpdate("Staff", p, { Name: p.Name, Role: p.Role, ContactNumber: p.ContactNumber, SalaryBasis: p.SalaryBasis, MonthlyAmount: p.MonthlyAmount || 0, DailyRate: p.DailyRate || 0, BFAmount: p.BFAmount || 0 }); if (!ok) return { success: false, message: "Staff not found." }; await auditLog(p.CreatedBy, "Updated Staff", "Staff", p.StaffID, p.Name); return { success: true, message: "Staff updated successfully." }; }
      case "deleteStaff": await genericDelete("Staff", p.StaffID); await auditLog(p.CreatedBy, "Deleted Staff", "Staff", p.StaffID, p.Name || ""); return { success: true, message: "Staff deleted successfully." };

      case "getStaffSalary": return { success: true, data: await colToArray("staffSalary") };
      case "addStaffSalary": { const net = (Number(p.Basic) || 0) + (Number(p.DA) || 0) - (Number(p.Deductions) || 0); const r = await genericAdd("StaffSalary", { Month: p.Month, StaffName: p.StaffName, Basic: p.Basic || 0, DA: p.DA || 0, Deductions: p.Deductions || 0, BFDue: 0, DaysWorked: p.DaysWorked || "", NetSalary: net, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Salary Slip", "StaffSalary", r.id, p.StaffName + " ₹" + net); return { success: true, message: "Salary slip saved successfully.", data: { NetSalary: net } }; }
      case "updateStaffSalary": { const net = (Number(p.Basic) || 0) + (Number(p.DA) || 0) - (Number(p.Deductions) || 0); const ok = await genericUpdate("StaffSalary", p, { Month: p.Month, StaffName: p.StaffName, Basic: p.Basic || 0, DA: p.DA || 0, Deductions: p.Deductions || 0, BFDue: 0, DaysWorked: p.DaysWorked || "", NetSalary: net, Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Salary slip not found." }; await auditLog(p.CreatedBy, "Updated Salary Slip", "StaffSalary", p.SalaryID, p.StaffName + " ₹" + net); return { success: true, message: "Salary slip updated successfully." }; }
      case "deleteStaffSalary": await genericDelete("StaffSalary", p.SalaryID); await auditLog(p.CreatedBy, "Deleted Staff Salary", "StaffSalary", p.SalaryID, ""); return { success: true, message: "Salary slip deleted successfully." };

      case "getStaffPayments": return { success: true, data: await colToArray("staffPayments") };
      case "addStaffPayment": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.AmountPaid); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("StaffPayment", { Date: p.Date, StaffName: p.StaffName, AmountPaid: p.AmountPaid, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber || "", Remarks: p.Remarks || "", WalletUser: "Sukadev", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Staff Payment", "StaffPayments", r.id, p.StaffName + " ₹" + p.AmountPaid); return { success: true, message: "Staff payment saved successfully." }; }
      case "updateStaffPayment": { const ok = await genericUpdate("StaffPayment", p, { Date: p.Date, StaffName: p.StaffName, AmountPaid: p.AmountPaid, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber, Remarks: p.Remarks, WalletUser: "Sukadev" }); if (!ok) return { success: false, message: "Staff payment not found." }; await auditLog(p.CreatedBy, "Updated Staff Payment", "StaffPayments", p.PaymentID, p.StaffName + " ₹" + p.AmountPaid); return { success: true, message: "Staff payment updated successfully." }; }
      case "deleteStaffPayment": await genericDelete("StaffPayment", p.PaymentID); await auditLog(p.CreatedBy, "Deleted Staff Payment", "StaffPayments", p.PaymentID, ""); return { success: true, message: "Staff payment deleted successfully." };

      case "getStaffAttendance": return { success: true, data: await colToArray("staffAttendance") };
      case "addStaffAttendance": { const arr = await colToArray("staffAttendance"); const ex = arr.find(function (x) { return x.Date === p.Date && x.StaffName === p.StaffName; }); if (ex) { await db.collection("staffAttendance").doc(ex.AttendanceID).set({ Status: p.Status }, { merge: true }); await auditLog(p.CreatedBy, "Updated Attendance", "StaffAttendance", ex.AttendanceID, p.StaffName + " " + p.Date + " " + p.Status); return { success: true, message: "Attendance updated successfully." }; } const r = await genericAdd("StaffAttendance", { Date: p.Date, StaffName: p.StaffName, Status: p.Status, MarkedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Marked Attendance", "StaffAttendance", r.id, p.StaffName + " " + p.Date + " " + p.Status); return { success: true, message: "Attendance marked successfully." }; }
      case "updateStaffAttendance": { const ok = await genericUpdate("StaffAttendance", p, { Date: p.Date, StaffName: p.StaffName, Status: p.Status }); if (!ok) return { success: false, message: "Attendance record not found." }; await auditLog(p.CreatedBy, "Updated Attendance", "StaffAttendance", p.AttendanceID, p.StaffName + " " + p.Date + " " + p.Status); return { success: true, message: "Attendance updated successfully." }; }

      case "getMistri": return { success: true, data: await colToArray("mistri") };
      case "addMistri": { const r = await genericAdd("Mistri", { Name: p.Name, ContactNumber: p.ContactNumber || "", DailyRate: p.DailyRate || 0, BFAmount: p.BFAmount || 0 }); await auditLog(p.CreatedBy, "Added Mistri", "Mistri", r.id, p.Name); return { success: true, message: "Mistri saved successfully." }; }
      case "updateMistri": { const ok = await genericUpdate("Mistri", p, { Name: p.Name, ContactNumber: p.ContactNumber || "", DailyRate: p.DailyRate || 0, BFAmount: p.BFAmount || 0 }); if (!ok) return { success: false, message: "Mistri not found." }; await auditLog(p.CreatedBy, "Updated Mistri", "Mistri", p.MistriID, p.Name); return { success: true, message: "Mistri updated successfully." }; }
      case "deleteMistri": await genericDelete("Mistri", p.MistriID); await auditLog(p.CreatedBy, "Deleted Mistri", "Mistri", p.MistriID, ""); return { success: true, message: "Mistri deleted successfully." };

      case "getMistriDue": return { success: true, data: await colToArray("mistriDue") };
      case "addMistriDue": { const net = (Number(p.Basic) || 0) + (Number(p.DA) || 0) - (Number(p.Deductions) || 0); const r = await genericAdd("MistriDue", { Month: p.Month, MistriName: p.MistriName, Site: p.Site, Basic: p.Basic || 0, DA: p.DA || 0, Deductions: p.Deductions || 0, NetDue: net, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Mistri Due", "MistriDue", r.id, p.MistriName + " @ " + p.Site + " ₹" + net); return { success: true, message: "Mistri due saved successfully.", data: { NetDue: net } }; }
      case "updateMistriDue": { const net = (Number(p.Basic) || 0) + (Number(p.DA) || 0) - (Number(p.Deductions) || 0); const ok = await genericUpdate("MistriDue", p, { Month: p.Month, MistriName: p.MistriName, Site: p.Site, Basic: p.Basic || 0, DA: p.DA || 0, Deductions: p.Deductions || 0, NetDue: net, Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Mistri due not found." }; await auditLog(p.CreatedBy, "Updated Mistri Due", "MistriDue", p.DueID, p.MistriName + " @ " + p.Site + " ₹" + net); return { success: true, message: "Mistri due updated successfully." }; }
      case "deleteMistriDue": await genericDelete("MistriDue", p.DueID); await auditLog(p.CreatedBy, "Deleted Mistri Due", "MistriDue", p.DueID, ""); return { success: true, message: "Mistri due deleted successfully." };

      case "getMistriPayments": return { success: true, data: await colToArray("mistriPayments") };
      case "addMistriPayment": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.AmountPaid); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("MistriPayment", { Date: p.Date, MistriName: p.MistriName, Site: p.Site, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod || "", ReferenceNumber: p.ReferenceNumber || "", Remarks: p.Remarks || "", WalletUser: "Sukadev", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Mistri Payment", "MistriPayments", r.id, p.MistriName + " @ " + p.Site + " ₹" + p.AmountPaid); return { success: true, message: "Mistri payment saved successfully." }; }
      case "updateMistriPayment": { const ok = await genericUpdate("MistriPayment", p, { Date: p.Date, MistriName: p.MistriName, Site: p.Site, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber, Remarks: p.Remarks, WalletUser: "Sukadev" }); if (!ok) return { success: false, message: "Mistri payment not found." }; await auditLog(p.CreatedBy, "Updated Mistri Payment", "MistriPayments", p.PaymentID, p.MistriName + " @ " + p.Site + " ₹" + p.AmountPaid); return { success: true, message: "Mistri payment updated successfully." }; }
      case "deleteMistriPayment": await genericDelete("MistriPayment", p.PaymentID); await auditLog(p.CreatedBy, "Deleted Mistri Payment", "MistriPayments", p.PaymentID, ""); return { success: true, message: "Mistri payment deleted successfully." };

      case "getMistriAdvances": return { success: true, data: await colToArray("mistriAdvances") };
      case "addMistriAdvance": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.Amount); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("MistriAdvance", { Date: p.Date, From: "Sukadev", MistriName: p.MistriName, Site: p.Site, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "", Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Mistri Advance", "MistriAdvances", r.id, p.MistriName + " @ " + p.Site + " ₹" + p.Amount); return { success: true, message: "Advance sent successfully." }; }
      case "updateMistriAdvance": { const ok = await genericUpdate("MistriAdvance", p, { Date: p.Date, From: p.From, MistriName: p.MistriName, Site: p.Site, Amount: p.Amount, PaymentMethod: p.PaymentMethod, Remarks: p.Remarks }); if (!ok) return { success: false, message: "Advance not found." }; await auditLog(p.CreatedBy, "Updated Mistri Advance", "MistriAdvances", p.AdvanceID, p.MistriName + " @ " + p.Site + " ₹" + p.Amount); return { success: true, message: "Advance updated successfully." }; }
      case "deleteMistriAdvance": await genericDelete("MistriAdvance", p.AdvanceID); await auditLog(p.CreatedBy, "Deleted Mistri Advance", "MistriAdvances", p.AdvanceID, ""); return { success: true, message: "Advance deleted successfully." };

      case "getLabour": return { success: true, data: await colToArray("labour") };
      case "addLabour": { const r = await genericAdd("Labour", { Name: p.Name, ContactNumber: p.ContactNumber || "", DefaultSite: p.DefaultSite || "", BFAmount: p.BFAmount || 0 }); await auditLog(p.CreatedBy, "Added Labour", "Labour", r.id, p.Name); return { success: true, message: "Labour saved successfully." }; }
      case "updateLabour": { const ok = await genericUpdate("Labour", p, { Name: p.Name, ContactNumber: p.ContactNumber || "", DefaultSite: p.DefaultSite || "", BFAmount: p.BFAmount || 0 }); if (!ok) return { success: false, message: "Labour not found." }; await auditLog(p.CreatedBy, "Updated Labour", "Labour", p.LabourID, p.Name); return { success: true, message: "Labour updated successfully." }; }
      case "deleteLabour": await genericDelete("Labour", p.LabourID); await auditLog(p.CreatedBy, "Deleted Labour", "Labour", p.LabourID, ""); return { success: true, message: "Labour deleted successfully." };

      case "getLabourEntries": return { success: true, data: await colToArray("labourEntries") };
      case "addLabourEntry": { const net = computeLabourNet(p); const r = await genericAdd("LabourEntry", { Date: p.Date, Month: p.Month, LabourName: p.LabourName, Site: p.Site, Type: p.Type, DailyPrice: p.DailyPrice || 0, HowManyLabour: p.HowManyLabour || 0, WorkMeter: p.WorkMeter || 0, Price: p.Price || 0, AdditionalAmount: p.AdditionalAmount || 0, Fare: p.Fare || 0, NetAmount: net, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Labour Entry", "LabourEntries", r.id, p.LabourName + " @ " + p.Site + " ₹" + net); return { success: true, message: "Labour entry saved successfully.", data: { NetAmount: net } }; }
      case "updateLabourEntry": { const net = computeLabourNet(p); const ok = await genericUpdate("LabourEntry", p, { Date: p.Date, Month: p.Month, LabourName: p.LabourName, Site: p.Site, Type: p.Type, DailyPrice: p.DailyPrice || 0, HowManyLabour: p.HowManyLabour || 0, WorkMeter: p.WorkMeter || 0, Price: p.Price || 0, AdditionalAmount: p.AdditionalAmount || 0, Fare: p.Fare || 0, NetAmount: net, Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Labour entry not found." }; await auditLog(p.CreatedBy, "Updated Labour Entry", "LabourEntries", p.EntryID, p.LabourName + " @ " + p.Site + " ₹" + net); return { success: true, message: "Labour entry updated successfully.", data: { NetAmount: net } }; }
      case "deleteLabourEntry": await genericDelete("LabourEntry", p.EntryID); await auditLog(p.CreatedBy, "Deleted Labour Entry", "LabourEntries", p.EntryID, ""); return { success: true, message: "Labour entry deleted successfully." };

      case "getLabourPayments": return { success: true, data: await colToArray("labourPayments") };
      case "addLabourPayment": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.AmountPaid); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("LabourPayment", { Date: p.Date, LabourName: p.LabourName, Site: p.Site, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod || "", ReferenceNumber: p.ReferenceNumber || "", Remarks: p.Remarks || "", WalletUser: "Sukadev", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Labour Payment", "LabourPayments", r.id, p.LabourName + " @ " + p.Site + " ₹" + p.AmountPaid); return { success: true, message: "Labour payment saved successfully." }; }
      case "updateLabourPayment": { const ok = await genericUpdate("LabourPayment", p, { Date: p.Date, LabourName: p.LabourName, Site: p.Site, AmountPaid: p.AmountPaid, DiscountAmount: p.DiscountAmount || 0, PaymentMethod: p.PaymentMethod, ReferenceNumber: p.ReferenceNumber, Remarks: p.Remarks, WalletUser: "Sukadev" }); if (!ok) return { success: false, message: "Labour payment not found." }; await auditLog(p.CreatedBy, "Updated Labour Payment", "LabourPayments", p.PaymentID, p.LabourName + " @ " + p.Site + " ₹" + p.AmountPaid); return { success: true, message: "Labour payment updated successfully." }; }
      case "deleteLabourPayment": await genericDelete("LabourPayment", p.PaymentID); await auditLog(p.CreatedBy, "Deleted Labour Payment", "LabourPayments", p.PaymentID, ""); return { success: true, message: "Labour payment deleted successfully." };

      case "getLabourAdvances": return { success: true, data: await colToArray("labourAdvances") };
      case "addLabourAdvance": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.Amount); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("LabourAdvance", { Date: p.Date, From: "Sukadev", LabourName: p.LabourName, Site: p.Site, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "", Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Labour Advance", "LabourAdvances", r.id, p.LabourName + " @ " + p.Site + " ₹" + p.Amount); return { success: true, message: "Advance sent successfully." }; }
      case "updateLabourAdvance": { const ok = await genericUpdate("LabourAdvance", p, { Date: p.Date, From: p.From, LabourName: p.LabourName, Site: p.Site, Amount: p.Amount, PaymentMethod: p.PaymentMethod, Remarks: p.Remarks }); if (!ok) return { success: false, message: "Advance not found." }; await auditLog(p.CreatedBy, "Updated Labour Advance", "LabourAdvances", p.AdvanceID, p.LabourName + " @ " + p.Site + " ₹" + p.Amount); return { success: true, message: "Advance updated successfully." }; }
      case "deleteLabourAdvance": await genericDelete("LabourAdvance", p.AdvanceID); await auditLog(p.CreatedBy, "Deleted Labour Advance", "LabourAdvances", p.AdvanceID, ""); return { success: true, message: "Advance deleted successfully." };

      case "getFundTransfers": return { success: true, data: await colToArray("fundTransfers") };
      case "addFundTransfer": { const effFrom = p.To === "Sukadev" ? p.From : "Sukadev"; const chk = await checkMoneySpend(p.CreatedBy, effFrom, p.Amount); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("FundTransfer", { Date: p.Date, From: effFrom, To: p.To, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "", Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Fund Transfer", "FundTransfers", r.id, effFrom + " -> " + p.To + " Rs." + p.Amount); return { success: true, message: "Fund transfer saved successfully." }; }
      case "updateFundTransfer": { const ok = await genericUpdate("FundTransfer", p, { Date: p.Date, From: p.From, To: p.To, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "", Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Fund transfer not found." }; await auditLog(p.CreatedBy, "Updated Fund Transfer", "FundTransfers", p.TransferID, p.From + " -> " + p.To + " Rs." + p.Amount); return { success: true, message: "Fund transfer updated successfully." }; }
      case "deleteFundTransfer": await genericDelete("FundTransfer", p.TransferID); await auditLog(p.CreatedBy, "Deleted Fund Transfer", "FundTransfers", p.TransferID, ""); return { success: true, message: "Fund transfer deleted successfully." };

      case "getSiteAllocations": return { success: true, data: await colToArray("siteAllocations") };
      case "addSiteAllocation": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.Amount); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("SiteAllocation", { Date: p.Date, User: p.User, Site: p.Site, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "Cash", Remarks: p.Remarks || "", WalletUser: "Sukadev", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Site Allocation", "SiteAllocations", r.id, p.User + " -> " + p.Site + " Rs." + p.Amount); return { success: true, message: "Site allocation saved successfully." }; }
      case "updateSiteAllocation": { const ok = await genericUpdate("SiteAllocation", p, { Date: p.Date, User: p.User, Site: p.Site, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "Cash", Remarks: p.Remarks || "", WalletUser: "Sukadev" }); if (!ok) return { success: false, message: "Site allocation not found." }; await auditLog(p.CreatedBy, "Updated Site Allocation", "SiteAllocations", p.AllocationID, p.User + " -> " + p.Site + " Rs." + p.Amount); return { success: true, message: "Site allocation updated successfully." }; }
      case "deleteSiteAllocation": await genericDelete("SiteAllocation", p.AllocationID); await auditLog(p.CreatedBy, "Deleted Site Allocation", "SiteAllocations", p.AllocationID, ""); return { success: true, message: "Site allocation deleted successfully." };

      case "getDriverAllocations": return { success: true, data: await colToArray("driverAllocations") };
      case "addDriverAllocation": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.Amount); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("DriverAllocation", { Date: p.Date, User: p.User, VehicleNumber: p.VehicleNumber, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "Cash", Remarks: p.Remarks || "", WalletUser: "Sukadev", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Driver Allocation", "DriverAllocations", r.id, p.User + " -> " + p.VehicleNumber + " Rs." + p.Amount); return { success: true, message: "Driver allocation saved successfully." }; }
      case "updateDriverAllocation": { const ok = await genericUpdate("DriverAllocation", p, { Date: p.Date, User: p.User, VehicleNumber: p.VehicleNumber, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "Cash", Remarks: p.Remarks || "", WalletUser: "Sukadev" }); if (!ok) return { success: false, message: "Driver allocation not found." }; await auditLog(p.CreatedBy, "Updated Driver Allocation", "DriverAllocations", p.AllocationID, p.User + " -> " + p.VehicleNumber + " Rs." + p.Amount); return { success: true, message: "Driver allocation updated successfully." }; }
      case "deleteDriverAllocation": await genericDelete("DriverAllocation", p.AllocationID); await auditLog(p.CreatedBy, "Deleted Driver Allocation", "DriverAllocations", p.AllocationID, ""); return { success: true, message: "Driver allocation deleted successfully." };

      case "getDuplicateReviews": return { success: true, data: await colToArray("duplicateReviews") };
      case "addDuplicateReview": { const r = await genericAdd("DuplicateReview", { Key: p.Key, Category: p.Category || "", ReviewedBy: p.CreatedBy || "", ReviewedAt: new Date().toISOString() }); return { success: true, message: "Marked reviewed.", data: { ReviewID: r.id } }; }

      case "getSiteExpenses": return { success: true, data: await colToArray("siteExpenses") };
      case "addSiteExpense": { const r = await genericAdd("SiteExpense", { Date: p.Date, Site: p.Site, Amount: p.Amount, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Site Expense", "SiteExpenses", r.id, p.Site + " Rs." + p.Amount); return { success: true, message: "Site expenditure saved successfully." }; }
      case "updateSiteExpense": { const ok = await genericUpdate("SiteExpense", p, { Date: p.Date, Site: p.Site, Amount: p.Amount, Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Site expense not found." }; await auditLog(p.CreatedBy, "Updated Site Expense", "SiteExpenses", p.ExpenseID, p.Site + " Rs." + p.Amount); return { success: true, message: "Site expenditure updated successfully." }; }
      case "deleteSiteExpense": await genericDelete("SiteExpense", p.ExpenseID); await auditLog(p.CreatedBy, "Deleted Site Expense", "SiteExpenses", p.ExpenseID, ""); return { success: true, message: "Site expense deleted successfully." };

      case "getSiteTransfers": return { success: true, data: await colToArray("siteTransfers") };
      case "addSiteTransfer": { if (p.FromSite === p.ToSite) return { success: false, message: "Pick two different sites." }; const r = await genericAdd("SiteTransfer", { Date: p.Date, FromSite: p.FromSite, ToSite: p.ToSite, Amount: p.Amount, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Site Transfer", "SiteTransfers", r.id, p.FromSite + " -> " + p.ToSite + " (" + p.Amount + ")"); return { success: true, message: "Balance transferred successfully.", id: r.id }; }
      case "updateSiteTransfer": { if (p.FromSite === p.ToSite) return { success: false, message: "Pick two different sites." }; const ok = await genericUpdate("SiteTransfer", p, { Date: p.Date, FromSite: p.FromSite, ToSite: p.ToSite, Amount: p.Amount, Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Site transfer not found." }; await auditLog(p.CreatedBy, "Updated Site Transfer", "SiteTransfers", p.TransferID, ""); return { success: true, message: "Site transfer updated successfully." }; }
      case "deleteSiteTransfer": await genericDelete("SiteTransfer", p.TransferID); await auditLog(p.CreatedBy, "Deleted Site Transfer", "SiteTransfers", p.TransferID, ""); return { success: true, message: "Site transfer deleted successfully." };

      case "getCementReceived": return { success: true, data: await colToArray("cementReceived") };
      case "addCementReceived": { const r = await genericAdd("CementReceived", { Date: p.Date, Site: p.Site, Bags: p.Bags, Amount: p.Amount || 0, PaymentMethod: p.PaymentMethod || "Cash", Party: p.Party || "", Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Cement Received", "CementReceived", r.id, p.Bags + " bags for " + p.Site); return { success: true, id: r.id, message: "Cement received logged." }; }
      case "updateCementReceived": { const ok = await genericUpdate("CementReceived", p, { Date: p.Date, Site: p.Site, Bags: p.Bags, Amount: p.Amount || 0, PaymentMethod: p.PaymentMethod || "Cash", Party: p.Party || "", Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Not found." }; await auditLog(p.CreatedBy, "Updated Cement Received", "CementReceived", p.ReceiptID, ""); return { success: true, message: "Updated." }; }
      case "deleteCementReceived": await genericDelete("CementReceived", p.ReceiptID); await auditLog(p.CreatedBy, "Deleted Cement Received", "CementReceived", p.ReceiptID, ""); return { success: true, message: "Deleted." };

      case "getCementUsed": return { success: true, data: await colToArray("cementUsed") };
      case "addCementUsed": { const r = await genericAdd("CementUsed", { Date: p.Date, Site: p.Site, Bags: p.Bags, Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Cement Used", "CementUsed", r.id, p.Bags + " bags at " + p.Site); return { success: true, id: r.id, message: "Cement usage logged." }; }
      case "updateCementUsed": { const ok = await genericUpdate("CementUsed", p, { Date: p.Date, Site: p.Site, Bags: p.Bags, Remarks: p.Remarks || "" }); if (!ok) return { success: false, message: "Not found." }; await auditLog(p.CreatedBy, "Updated Cement Used", "CementUsed", p.UsageID, ""); return { success: true, message: "Updated." }; }
      case "deleteCementUsed": await genericDelete("CementUsed", p.UsageID); await auditLog(p.CreatedBy, "Deleted Cement Used", "CementUsed", p.UsageID, ""); return { success: true, message: "Deleted." };

      case "getOtherPayments": return { success: true, data: await colToArray("otherPayments") };

      case "signup": {
        const name = String(p.Name || "").trim();
        if (!name || !p.Password) return { success: false, message: "Name and password are required." };
        const users = await colToArray("users");
        const dup = users.find(function (x) { return String(x.Name).toLowerCase() === name.toLowerCase(); });
        if (dup) return { success: false, message: "That name is already registered. Choose a different name or contact Admin." };
        const r = await genericAdd("User", { Name: name, Password: String(p.Password), ContactNumber: p.ContactNumber || "" });
        await auditLog(name, "Requested Account", "Users", r.id, "Signup pending approval");
        return { success: true, message: "Account request submitted. Hrushikesh Padhi needs to approve it before you can log in." };
      }
      case "approveUser": {
        if (String(p.RequestedBy || "").toLowerCase() !== "hrushikesh padhi") return { success: false, message: "Only Hrushikesh Padhi can approve accounts." };
        const ok = await genericUpdate("User", { UserID: p.UserID }, { Status: "Active", Role: p.Role || "Admin 3", MoneyEnabled: false });
        if (!ok) return { success: false, message: "User not found." };
        await auditLog(p.RequestedBy, "Approved User", "Users", p.UserID, p.Name + " as " + (p.Role || "Admin 3"));
        return { success: true, message: p.Name + " approved and can now log in. Money features are off until you enable them." };
      }
      case "setMoneyPermission": {
        if (String(p.RequestedBy || "").toLowerCase() !== "hrushikesh padhi") return { success: false, message: "Only Hrushikesh Padhi can change money permissions." };
        const ok = await genericUpdate("User", { UserID: p.UserID }, { MoneyEnabled: !!p.Enabled });
        if (!ok) return { success: false, message: "User not found." };
        await auditLog(p.RequestedBy, p.Enabled ? "Enabled Money Access" : "Disabled Money Access", "Users", p.UserID, p.Name || "");
        return { success: true, message: (p.Name || "User") + (p.Enabled ? " can now send/spend money." : "'s money access was turned off.") };
      }
      case "rejectUser": {
        if (String(p.RequestedBy || "").toLowerCase() !== "hrushikesh padhi") return { success: false, message: "Only Hrushikesh Padhi can reject accounts." };
        const ok = await genericUpdate("User", { UserID: p.UserID }, { Status: "Rejected" });
        if (!ok) return { success: false, message: "User not found." };
        await auditLog(p.RequestedBy, "Rejected User", "Users", p.UserID, p.Name || "");
        return { success: true, message: "Request rejected." };
      }
      case "addOtherPayment": { const chk = await checkMoneySpend(p.CreatedBy, "Sukadev", p.Amount); if (!chk.ok) return { success: false, message: chk.message }; const r = await genericAdd("OtherPayment", { Date: p.Date, From: p.From, WalletUser: "Sukadev", Name: p.Name, Purpose: p.Purpose, Amount: p.Amount, PaymentMethod: p.PaymentMethod || "Cash", Remarks: p.Remarks || "", CreatedBy: p.CreatedBy || "" }); await auditLog(p.CreatedBy, "Added Other Payment", "OtherPayments", r.id, p.Name + " ₹" + p.Amount); return { success: true, message: "Payment saved successfully." }; }
      case "updateOtherPayment": { const ok = await genericUpdate("OtherPayment", p, { Date: p.Date, From: p.From, WalletUser: "Sukadev", Name: p.Name, Purpose: p.Purpose, Amount: p.Amount, PaymentMethod: p.PaymentMethod, Remarks: p.Remarks }); if (!ok) return { success: false, message: "Payment not found." }; await auditLog(p.CreatedBy, "Updated Other Payment", "OtherPayments", p.PaymentID, p.Name + " ₹" + p.Amount); return { success: true, message: "Payment updated successfully." }; }
      case "deleteOtherPayment": await genericDelete("OtherPayment", p.PaymentID); await auditLog(p.CreatedBy, "Deleted Other Payment", "OtherPayments", p.PaymentID, ""); return { success: true, message: "Payment deleted successfully." };

      case "getTaskCompletions": return { success: true, data: await colToArray("taskCompletions") };
      case "addTaskCompletion": { const arr = await colToArray("taskCompletions"); const exists = arr.some(function (x) { return x.Date === p.Date && x.User === p.User; }); if (exists) return { success: true, message: "Already marked completed." }; const id = p.Date + "_" + p.User; await db.collection("taskCompletions").doc(id).set({ Date: p.Date, User: p.User, CreatedAt: new Date().toISOString() }); await auditLog(p.User, "Marked Task Completed", "TaskCompletions", p.Date, p.User); return { success: true, message: "Task marked completed." }; }

      case "getBilling": {
        const invSnap = await db.collection("billing").doc("invoice").get();
        const mSnap = await db.collection("billing").doc("maintenance").get();
        const inv = invSnap.exists ? invSnap.data() : { amount: 478, status: "Pending" };
        const maint = mSnap.exists ? mSnap.data() : { amount: 125, firstDueYear: 2027, paidYears: [] };
        return { success: true, invoice: inv, maintenance: maint };
      }
      case "markInvoicePaid": {
        if (String(p.RequestedBy || "").toLowerCase() !== "hrushikesh padhi") return { success: false, message: "Only Hrushikesh Padhi can mark this as paid." };
        await db.collection("billing").doc("invoice").set({ amount: 478, status: "Paid", paidAt: new Date().toISOString(), paidBy: p.RequestedBy }, { merge: true });
        await auditLog(p.RequestedBy, "Marked Invoice Paid", "Billing", "invoice", "$478");
        return { success: true, message: "Invoice marked as paid." };
      }
      case "markMaintenancePaid": {
        if (String(p.RequestedBy || "").toLowerCase() !== "hrushikesh padhi") return { success: false, message: "Only Hrushikesh Padhi can mark this as paid." };
        const ref = db.collection("billing").doc("maintenance");
        const snap = await ref.get();
        const data = snap.exists ? snap.data() : { amount: 125, firstDueYear: 2027, paidYears: [] };
        const years = data.paidYears || [];
        if (years.indexOf(p.CycleYear) === -1) years.push(p.CycleYear);
        await ref.set({ amount: 125, firstDueYear: data.firstDueYear || 2027, paidYears: years, lastPaidAt: new Date().toISOString(), lastPaidBy: p.RequestedBy }, { merge: true });
        await auditLog(p.RequestedBy, "Marked Maintenance Paid", "Billing", "maintenance", "$125 for " + p.CycleYear);
        return { success: true, message: "Maintenance fee marked as paid for " + p.CycleYear + "." };
      }

      case "migrateFromSheets": return migrateFromSheets(p);

      // ---------- Panda Home Pipes ----------
      case "hpGetAllData": {
        const names = ["hpProduction", "hpSales", "hpCashbook", "hpPrices", "hpMistri", "hpMistriPayments", "hpMaterialPurchases", "hpMaterialSales"];
        const arrs = await Promise.all(names.map(colToArray));
        const out = { success: true, categories: HP_CATEGORIES, inchFactor: HP_INCH_FACTOR, materials: HP_MATERIALS, sellableMaterials: HP_SELLABLE_MATERIALS };
        names.forEach(function (n, i) { out[n] = arrs[i]; });
        const st = await getSettingsMap();
        out.maintenance = { enabled: st.HPMaintenanceMode === undefined ? true : String(st.HPMaintenanceMode) === "TRUE", message: st.HPMaintenanceMessage || "Panda Home Pipes is being set up. Please check back soon." };
        return out;
      }
      case "hpSetMaintenance": {
        const users = await colToArray("users");
        const requester = users.find(function (x) { return String(x.Name).toLowerCase() === String(p.RequestedBy || "").toLowerCase(); });
        if (!requester || requester.Role !== "Admin 1") return { success: false, message: "Only Hrushikesh Padhi can change Home Pipes maintenance mode." };
        await setSettingValue("HPMaintenanceMode", p.Enabled ? "TRUE" : "FALSE");
        if (p.Message !== undefined) await setSettingValue("HPMaintenanceMessage", p.Message);
        await auditLog(p.RequestedBy, p.Enabled ? "Enabled HP Maintenance" : "Disabled HP Maintenance", "HomePipes", "", p.Message || "");
        return { success: true, message: "Home Pipes maintenance mode updated." };
      }
      case "hpAddProduction": { const r = await genericAdd("HPProduction", { Date: p.Date, Qty: p.Qty || {}, MaterialsUsed: p.MaterialsUsed || {}, ProductionCost: p.ProductionCost || 0, Notes: p.Notes || "", CreatedBy: p.CreatedBy }); await auditLog(p.CreatedBy, "Added HP Production", "HomePipes-Production", r.id, p.Date); return { success: true, id: r.id, rec: r.rec }; }
      case "updateHPProduction": { const ok = await genericUpdate("HPProduction", p, { Date: p.Date, Qty: p.Qty || {}, MaterialsUsed: p.MaterialsUsed || {}, ProductionCost: p.ProductionCost || 0, Notes: p.Notes || "" }); if (ok) await auditLog(p.CreatedBy, "Updated HP Production", "HomePipes-Production", p.ProdID, p.Date); return { success: ok }; }
      case "deleteHPProduction": await genericDelete("HPProduction", p.ProdID); await auditLog(p.CreatedBy, "Deleted HP Production", "HomePipes-Production", p.ProdID, ""); return { success: true, message: "Production entry deleted." };

      case "hpAddSale": { const r = await genericAdd("HPSale", { Date: p.Date, PartyName: p.PartyName || "Local", MobileNo: p.MobileNo || "", Qty: p.Qty || {}, Rate: p.Rate || 0, Amount: p.Amount || 0, Freight: p.Freight || 0, Loading: p.Loading || 0, Total: p.Total || 0, Payment: p.Payment || 0, Due: p.Due || 0, CreatedBy: p.CreatedBy }); await auditLog(p.CreatedBy, "Added HP Sale", "HomePipes-Sales", r.id, p.PartyName || ""); return { success: true, id: r.id, rec: r.rec }; }
      case "updateHPSale": { const ok = await genericUpdate("HPSale", p, { Date: p.Date, PartyName: p.PartyName || "Local", MobileNo: p.MobileNo || "", Qty: p.Qty || {}, Rate: p.Rate || 0, Amount: p.Amount || 0, Freight: p.Freight || 0, Loading: p.Loading || 0, Total: p.Total || 0, Payment: p.Payment || 0, Due: p.Due || 0 }); if (ok) await auditLog(p.CreatedBy, "Updated HP Sale", "HomePipes-Sales", p.SaleID, p.PartyName || ""); return { success: ok }; }
      case "deleteHPSale": await genericDelete("HPSale", p.SaleID); await auditLog(p.CreatedBy, "Deleted HP Sale", "HomePipes-Sales", p.SaleID, ""); return { success: true, message: "Sale entry deleted." };

      case "hpAddCashbook": { const r = await genericAdd("HPCashbook", { Date: p.Date, Category: p.Category, Type: p.Type, Amount: p.Amount || 0, Description: p.Description || "", CreatedBy: p.CreatedBy }); await auditLog(p.CreatedBy, "Added HP Cashbook Entry", "HomePipes-Cashbook", r.id, p.Category || ""); return { success: true, id: r.id, rec: r.rec }; }
      case "deleteHPCashbook": await genericDelete("HPCashbook", p.EntryID); await auditLog(p.CreatedBy, "Deleted HP Cashbook Entry", "HomePipes-Cashbook", p.EntryID, ""); return { success: true, message: "Cash book entry deleted." };

      case "hpSetPrice": {
        const cat = p.Category;
        await db.collection("hpPrices").doc(cat).set({ Category: cat, SellPrice: p.SellPrice || 0, CostPrice: p.CostPrice || 0, Unit: p.Unit || "Pcs" }, { merge: true });
        await auditLog(p.CreatedBy, "Updated HP Price", "HomePipes-Prices", cat, "Sell " + p.SellPrice + " / Cost " + p.CostPrice);
        return { success: true, message: "Price updated." };
      }

      case "hpAddMistri": { const r = await genericAdd("HPMistri", { Name: p.Name, ContactNumber: p.ContactNumber || "", RatePerInch: p.RatePerInch || 0 }); await auditLog(p.CreatedBy, "Added HP Mistri", "HomePipes-Mistri", r.id, p.Name || ""); return { success: true, id: r.id, rec: r.rec }; }
      case "updateHPMistri": { const ok = await genericUpdate("HPMistri", p, { Name: p.Name, ContactNumber: p.ContactNumber || "", RatePerInch: p.RatePerInch || 0, Status: p.Status || "Active" }); return { success: ok }; }
      case "deleteHPMistri": await genericDelete("HPMistri", p.MistriID); return { success: true, message: "Mistri deleted." };
      case "hpAddMistriPayment": { const r = await genericAdd("HPMistriPayment", { Date: p.Date, MistriID: p.MistriID, MistriName: p.MistriName || "", Amount: p.Amount || 0, Type: p.Type || "Payment", Notes: p.Notes || "", CreatedBy: p.CreatedBy }); await auditLog(p.CreatedBy, "Added HP Mistri Payment", "HomePipes-Mistri", r.id, p.MistriName || ""); return { success: true, id: r.id, rec: r.rec }; }
      case "deleteHPMistriPayment": await genericDelete("HPMistriPayment", p.PaymentID); return { success: true, message: "Payment deleted." };

      case "hpAddMaterialPurchase": { const r = await genericAdd("HPMaterialPurchase", { Date: p.Date, Material: p.Material, Qty: p.Qty || 0, Rate: p.Rate || 0, Amount: (p.Qty || 0) * (p.Rate || 0), Supplier: p.Supplier || "", Notes: p.Notes || "", CreatedBy: p.CreatedBy }); await auditLog(p.CreatedBy, "Added HP Material Purchase", "HomePipes-Materials", r.id, p.Material || ""); return { success: true, id: r.id, rec: r.rec }; }
      case "deleteHPMaterialPurchase": await genericDelete("HPMaterialPurchase", p.PurchaseID); return { success: true, message: "Purchase deleted." };
      case "hpAddMaterialSale": { const r = await genericAdd("HPMaterialSale", { Date: p.Date, Material: p.Material, Qty: p.Qty || 0, Rate: p.Rate || 0, Amount: (p.Qty || 0) * (p.Rate || 0), Buyer: p.Buyer || "", Notes: p.Notes || "", CreatedBy: p.CreatedBy }); await auditLog(p.CreatedBy, "Added HP Material Sale", "HomePipes-Materials", r.id, p.Material || ""); return { success: true, id: r.id, rec: r.rec }; }
      case "deleteHPMaterialSale": await genericDelete("HPMaterialSale", p.MatSaleID); return { success: true, message: "Sale deleted." };

      case "hpBulkImport": {
        const kind = p.Kind === "sale" ? "HPSale" : "HPProduction";
        let n = 0;
        for (const row of (p.Rows || [])) { await genericAdd(kind, Object.assign({ CreatedBy: p.CreatedBy }, row)); n++; }
        await auditLog(p.CreatedBy, "Bulk Imported HP " + p.Kind, "HomePipes-Import", "", n + " rows");
        return { success: true, message: n + " rows imported." };
      }

      default: return { success: false, message: "Unknown action: " + action };
    }
  }

  // ---------- one-time migration from the old Google Sheets backend ----------
  async function migrateFromSheets() {
    if (!window.OLD_GAS_URL) return { success: false, message: "No old Apps Script URL configured." };
    let res;
    try {
      const r = await fetch(window.OLD_GAS_URL + "?action=getAllData");
      res = await r.json();
    } catch (e) { return { success: false, message: "Could not reach old Google Sheets backend: " + e.message }; }
    if (!res || !res.success) return { success: false, message: "Old backend returned no data." };

    const idFieldByColl = {
      suppliers: "SupplierID", transactions: "SLNo", payments: "PaymentID", dieselTx: "SLNo", dieselPayments: "PaymentID",
      sites: "SiteID", materials: "MaterialID", users: "UserID", staff: "StaffID", staffSalary: "SalaryID",
      staffPayments: "PaymentID", staffAttendance: "AttendanceID", mistri: "MistriID", mistriDue: "DueID",
      mistriPayments: "PaymentID", mistriAdvances: "AdvanceID", labour: "LabourID", labourEntries: "EntryID",
      labourPayments: "PaymentID", labourAdvances: "AdvanceID", fundTransfers: "TransferID", siteAllocations: "AllocationID",
      siteExpenses: "ExpenseID"
    };
    const collSourceKey = {
      suppliers: "suppliers", transactions: "transactions", payments: "payments", bf: "bf",
      dieselTx: "dieselTx", dieselPayments: "dieselPayments", dieselBF: "dieselBF", sites: "sites",
      materials: "materials", users: "users", staff: "staff", staffSalary: "staffSalary", staffPayments: "staffPayments",
      staffAttendance: "staffAttendance", mistri: "mistri", mistriDue: "mistriDue", mistriPayments: "mistriPayments",
      mistriAdvances: "mistriAdvances", labour: "labour", labourEntries: "labourEntries", labourPayments: "labourPayments",
      labourAdvances: "labourAdvances", fundTransfers: "fundTransfers", siteAllocations: "siteAllocations",
      siteExpenses: "siteExpenses", taskCompletions: "taskCompletions", auditLog: "auditLog"
    };

    // Sync ID counters to the highest migrated numeric suffix so new records never collide
    // with (and silently overwrite) migrated ones.
    const counterByColl = {
      suppliers: ["SupplierID", "SUP"], transactions: ["SLNo", ""], payments: ["PaymentID", "PAY"],
      dieselTx: ["SLNo", ""], dieselPayments: ["PaymentID", "DPAY"], sites: ["SiteID", "S"], materials: ["MaterialID", "M"],
      staff: ["StaffID", "ST"], staffSalary: ["SalaryID", "SAL"], staffPayments: ["PaymentID", "SPAY"],
      staffAttendance: ["AttendanceID", "ATT"], mistri: ["MistriID", "MI"], mistriDue: ["DueID", "MD"],
      mistriPayments: ["PaymentID", "MP"], mistriAdvances: ["AdvanceID", "MA"], labour: ["LabourID", "LB"],
      labourEntries: ["EntryID", "LE"], labourPayments: ["PaymentID", "LP"], labourAdvances: ["AdvanceID", "LA"],
      fundTransfers: ["TransferID", "FT"], siteAllocations: ["AllocationID", "SA"], siteExpenses: ["ExpenseID", "SE"]
    };
    const counterNameByColl = {
      suppliers: "SupplierID", transactions: "SLNo", payments: "PaymentID", dieselTx: "DieselSLNo", dieselPayments: "DieselPaymentID",
      sites: "SiteID", materials: "MaterialID", staff: "StaffID", staffSalary: "SalaryID", staffPayments: "StaffPaymentID",
      staffAttendance: "AttendanceID", mistri: "MistriID", mistriDue: "DueID", mistriPayments: "MistriPaymentID",
      mistriAdvances: "MistriAdvanceID", labour: "LabourID", labourEntries: "EntryID", labourPayments: "LabourPaymentID",
      labourAdvances: "LabourAdvanceID", fundTransfers: "TransferID", siteAllocations: "AllocationID", siteExpenses: "ExpenseID"
    };
    let written = 0;
    for (const coll in collSourceKey) {
      const rows = res[collSourceKey[coll]] || [];
      if (!rows.length) continue;
      const idField = idFieldByColl[coll];
      let batch = db.batch(); let inBatch = 0;
      for (const row of rows) {
        const docId = idField && row[idField] !== undefined && row[idField] !== "" ? String(row[idField]) : db.collection(coll).doc().id;
        batch.set(db.collection(coll).doc(docId), row);
        inBatch++; written++;
        if (inBatch >= 450) { await batch.commit(); batch = db.batch(); inBatch = 0; }
      }
      if (inBatch > 0) await batch.commit();
      if (counterByColl[coll]) {
        const [idField, prefix] = counterByColl[coll];
        let maxN = 0;
        rows.forEach(function (row) {
          const raw = String(row[idField] || "");
          const num = Number(prefix ? raw.replace(prefix, "") : raw);
          if (!isNaN(num) && num > maxN) maxN = num;
        });
        if (maxN > 0) {
          const cname = counterNameByColl[coll];
          await db.collection("meta").doc("counters").set((function () { const o = {}; o[cname] = maxN; return o; })(), { merge: true });
        }
      }
    }
    // seed settings if missing
    const settingsSnap = await db.collection("settings").get();
    if (settingsSnap.empty) {
      await db.collection("settings").doc("LoginPassword").set({ Value: "panda@123" });
      await db.collection("settings").doc("CompanyName").set({ Value: "PANDA CONSTRUCTION" });
      await db.collection("settings").doc("MaintenanceMode").set({ Value: "FALSE" });
      await db.collection("settings").doc("MaintenanceMessage").set({ Value: "" });
    }
    return { success: true, message: "Migration complete — " + written + " records copied into Firestore." };
  }

  function trackUsage(kind, n) {
    try {
      const key = 'panda_usage_' + new Date().toISOString().slice(0, 10);
      const cur = JSON.parse(localStorage.getItem(key) || '{"reads":0,"writes":0,"deletes":0}');
      cur[kind] = (cur[kind] || 0) + n;
      localStorage.setItem(key, JSON.stringify(cur));
    } catch (e) {}
  }
  window.PandaAPI = {
    isDemo: false,
    getUsageEstimate: function () {
      try { return JSON.parse(localStorage.getItem('panda_usage_' + new Date().toISOString().slice(0, 10)) || '{"reads":0,"writes":0,"deletes":0}'); }
      catch (e) { return { reads: 0, writes: 0, deletes: 0 }; }
    },
    call: function (action, payload) {
      return route(action, payload).then(function (res) {
        if (/^get/.test(action)) trackUsage('reads', (res && res.data && res.data.length) || (action === 'getAllData' ? 500 : 1));
        else if (/^add/.test(action)) trackUsage('writes', 2);
        else if (/^update/.test(action)) trackUsage('writes', 1);
        else if (/^delete/.test(action)) trackUsage('deletes', 1);
        return res;
      }).catch(function (e) { console.error("PandaAPI (Firestore): " + action + " failed", e); return { success: false, message: "Database error: " + e.message }; });
    }
  };
})();
