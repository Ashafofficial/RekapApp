// ========================================================
// DATABASE ENGINE: NUMERIC ID SYNC & OFFLINE FIRST (TAURI + SUPABASE)
// ========================================================

const SUPABASE_URL = "https://dhrnbqitaxykmufucucv.supabase.co";
const SUPABASE_KEY = "sb_publishable_I0ehNCjUO9Y-FULSmMVPAg_3VlsLqL6";

// KTP Perangkat & VVIP Token
const tokenPerangkat = localStorage.getItem('sarimbit_vip_token') || 'TIDAK-ADA-SERTIFIKAT';

// Inisialisasi Dexie.js (Penyimpanan Lokal Utama)
const dbLokal = new Dexie("SarimbitPro_DB");
dbLokal.version(11).stores({
    orders: '++id, idcustomer, customer, sarimbit, syncstatus, isArchived, updated_at',
    master: '++id, pusat, sarimbit, barang, updated_at',
    pembukuan: '++id, sarimbit, isArchived, isPrinted, isInformed, updated_at',
    metadata: 'key',
    logs: '++id, action, module, detail, device, time, syncstatus',
    setoran_pusat: 'id, disetor, syncstatus, updated_at'
});

dbLokal.open().catch("UpgradeError", function (e) {
    console.warn("Bentrok struktur data terdeteksi. Melakukan reset otomatis...");
    Dexie.delete("SarimbitPro_DB").then(() => location.reload());
}).catch(e => console.error("Gagal membuka database:", e.message));

// ========================================================
// FUNGSI UTILITAS INTERNAL
// ========================================================

function generateNumericID() {
    return Date.now() + Math.floor(Math.random() * 1000);
}

// Fungsi Fetch Khusus Supabase (Anti Duplikasi Angka/String)
async function supabaseFetch(endpoint, options = {}) {
    try {
        const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
            ...options,
            headers: { 
                "apikey": SUPABASE_KEY, 
                "Authorization": `Bearer ${SUPABASE_KEY}`, 
                "Content-Type": "application/json",
                "x-sacha-token": tokenPerangkat,
                ...options.headers
            }
        });
        
        if (!res.ok) return null;
        
        const textData = await res.text();
        if (!textData) return null;

        return JSON.parse(textData, (key, value) => {
            const kolomAngka = ['syncstatus', 'diskonNilai', 'jumlah', 'harga', 'total', 'berat', 'cicilan1', 'cicilan2', 'cicilan3', 'ongkir', 'dp', 'bayar', 'omset', 'disetor'];
            if (key === 'id' && value !== null && value !== "") {
                const nilaiAngka = Number(value);
                if (!isNaN(nilaiAngka)) return nilaiAngka;
                return value;
            }
            if (kolomAngka.includes(key) && value !== null && value !== "") return Number(value);
            return value;
        });
    } catch (e) { return null; }
}

// ========================================================
// API GERBANG UTAMA (DIPANGGIL OLEH INDEX.HTML)
// ========================================================

window.DatabaseAPI = {
    // 1. AMBIL SEMUA DATA (LOKAL & SINKRON CLOUD JIKA ONLINE)
    getAllData: async function(onSuccess, onFailure) {
        try {
            // Ambil dari lokal dulu agar UI cepat tampil
            let localMaster = await dbLokal.master.toArray();
            let localOrders = await dbLokal.orders.filter(o => o.syncstatus !== -1 && o.isarchived !== true && o.isArchived !== true).toArray();
            let localPembukuan = await dbLokal.pembukuan.toArray(); 
            
            localOrders.sort((a, b) => {
                const dateA = a.tanggal ? new Date(a.tanggal).getTime() : 0;
                const dateB = b.tanggal ? new Date(b.tanggal).getTime() : 0;
                if (dateA === dateB) return a.id - b.id; 
                return dateB - dateA;
            });
            
            if (onSuccess) onSuccess({ master: localMaster, orders: localOrders, pembukuan: localPembukuan });

            // Proses Sinkronisasi di Balik Layar
            if (navigator.onLine) {
                await this.syncOfflineData();

                // Sinkron Master
                const lastSyncMaster = (await dbLokal.metadata.get("last_sync_master"))?.value || "1970-01-01T00:00:00Z";
                const cloudMaster = await supabaseFetch(`/rest/v1/master?select=*&updated_at=gt.${encodeURIComponent(lastSyncMaster)}&limit=5000`);
                if (cloudMaster && cloudMaster.length > 0) {
                    await dbLokal.master.bulkPut(cloudMaster);
                    const maxM = cloudMaster.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSyncMaster);
                    await dbLokal.metadata.put({ key: "last_sync_master", value: maxM });
                }

                // Sinkron Orders
                const lastSyncOrder = (await dbLokal.metadata.get("last_sync_order"))?.value || "1970-01-01T00:00:00Z";
                let cloudOrders = [];
                let offsetOrder = 0;
                const limitPerBatch = 1000; 
                let keepFetchingOrder = true;
                
                while (keepFetchingOrder) {
                    const batch = await supabaseFetch(`/rest/v1/orders?select=*&updated_at=gt.${encodeURIComponent(lastSyncOrder)}&order=updated_at.asc&limit=${limitPerBatch}&offset=${offsetOrder}`);
                    if (batch && batch.length > 0) {
                        cloudOrders = cloudOrders.concat(batch);
                        if (batch.length < limitPerBatch) keepFetchingOrder = false;
                        else offsetOrder += limitPerBatch;
                    } else keepFetchingOrder = false;
                }

                if (cloudOrders.length > 0) {
                    const dataAktif = cloudOrders.filter(o => o.syncstatus !== -1);
                    const dataDihapusPusat = cloudOrders.filter(o => o.syncstatus === -1);
                    const pendingLokal = await dbLokal.orders.filter(o => o.syncstatus === 0 || o.syncstatus === -1).toArray();
                    const idPendingLokal = pendingLokal.map(o => o.id);

                    if (dataAktif.length > 0) {
                        const dataAktifAman = dataAktif.filter(o => !idPendingLokal.includes(o.id));
                        if (dataAktifAman.length > 0) await dbLokal.orders.bulkPut(dataAktifAman.map(o => ({...o, syncstatus: 1})));
                    }

                    if (dataDihapusPusat.length > 0) {
                        const idsToDel = dataDihapusPusat.map(o => o.id);
                        await dbLokal.orders.where('id').anyOf(idsToDel).delete();
                    }

                    const maxO = cloudOrders.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSyncOrder);
                    await dbLokal.metadata.put({ key: "last_sync_order", value: maxO });
                }

                // Sinkron Pembukuan
                const lastSyncPembukuan = (await dbLokal.metadata.get("last_sync_pembukuan"))?.value || "1970-01-01T00:00:00Z";
                const cloudPembukuan = await supabaseFetch(`/rest/v1/pembukuan?select=*&updated_at=gt.${encodeURIComponent(lastSyncPembukuan)}`);
                if (cloudPembukuan && cloudPembukuan.length > 0) {
                    await dbLokal.pembukuan.bulkPut(cloudPembukuan);
                    const maxP = cloudPembukuan.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSyncPembukuan);
                    await dbLokal.metadata.put({ key: "last_sync_pembukuan", value: maxP });
                }

                // Sinkron Setoran
                const lastSyncSetoran = (await dbLokal.metadata.get("last_sync_setoran"))?.value || "1970-01-01T00:00:00Z";
                const cloudSetoran = await supabaseFetch(`/rest/v1/setoran_pusat?select=*&updated_at=gt.${encodeURIComponent(lastSyncSetoran)}`);
                if (cloudSetoran && cloudSetoran.length > 0) {
                    await dbLokal.setoran_pusat.bulkPut(cloudSetoran.map(s => ({...s, syncstatus: 1})));
                    const maxS = cloudSetoran.reduce((max, s) => s.updated_at > max ? s.updated_at : max, lastSyncSetoran);
                    await dbLokal.metadata.put({ key: "last_sync_setoran", value: maxS });
                    
                    let memoriSetoran = {};
                    const semuaSetoranLokal = await dbLokal.setoran_pusat.toArray();
                    semuaSetoranLokal.forEach(s => memoriSetoran[s.id] = s.disetor);
                    localStorage.setItem('DataSetoranPusat', JSON.stringify(memoriSetoran));
                }

                // Hapus Data Arsip Lokal yang terdeteksi
                const daftarArsip = await dbLokal.pembukuan.filter(p => p.isarchived === true || p.isArchived === true).toArray();
                const namaSarimbitArsip = daftarArsip.map(p => p.sarimbit);
                if (namaSarimbitArsip.length > 0) {
                    await dbLokal.master.where('sarimbit').anyOf(namaSarimbitArsip).delete();
                    await dbLokal.orders.where('sarimbit').anyOf(namaSarimbitArsip).delete();
                }

                // Return Update Terakhir ke UI jika ada perubahan
                localMaster = await dbLokal.master.toArray();
                localOrders = await dbLokal.orders.filter(o => o.syncstatus !== -1 && o.isarchived !== true && o.isArchived !== true).toArray();
                localPembukuan = await dbLokal.pembukuan.toArray(); 
                localOrders.sort((a, b) => {
                    const dateA = a.tanggal ? new Date(a.tanggal).getTime() : 0;
                    const dateB = b.tanggal ? new Date(b.tanggal).getTime() : 0;
                    if (dateA === dateB) return a.id - b.id; 
                    return dateB - dateA;
                });
                
                if (onSuccess) onSuccess({ master: localMaster, orders: localOrders, pembukuan: localPembukuan });
            }
        } catch(e) { if (onFailure) onFailure(e); }
    },

    // 2. SIMPAN ORDERAN BARU/EDIT
    saveOrders: async function(items, onSuccess, onFailure) {
        const now = new Date().toISOString();
        const baseId = Date.now(); 
        
        const dataWithId = items.map((it, idx) => ({
            ...it,
            id: it.id || (baseId + idx),
            updated_at: now,
            syncstatus: 0,
            harga: Number(it.harga) || 0, jumlah: Number(it.jumlah) || 0, total: Number(it.total) || 0,
            berat: Number(it.berat) || 0, cicilan1: Number(it.cicilan1) || 0, cicilan2: Number(it.cicilan2) || 0,
            cicilan3: Number(it.cicilan3) || 0, ongkir: Number(it.ongkir) || 0, diskonNilai: Number(it.diskonNilai) || 0
        }));

        try {
            await dbLokal.orders.bulkPut(dataWithId); // Simpan Lokal Dulu
            
            if (navigator.onLine) {
                const payloadCloud = dataWithId.map(item => { const { syncstatus, ...dataBersih } = item; return dataBersih; });
                const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
                    method: "POST",
                    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates", "x-sacha-token": tokenPerangkat },
                    body: JSON.stringify(payloadCloud)
                });
                if (res.ok) {
                    const idsToUpdate = dataWithId.map(d => d.id);
                    await dbLokal.orders.where('id').anyOf(idsToUpdate).modify({ syncstatus: 1 });
                }
            }
            if(onSuccess) onSuccess("Data Berhasil Disimpan!");
        } catch(e) { if(onSuccess) onSuccess("Tersimpan secara Offline."); }
    },

    // 3. SINKRONISASI OFFLINE ANTRIAN
    syncOfflineData: async function() {
        if (!navigator.onLine) return;
        try {
            const pending = await dbLokal.orders.filter(o => o.syncstatus === 0).toArray();
            const deleted = await dbLokal.orders.filter(o => o.syncstatus === -1).toArray();
            
            if (pending.length > 0) {
                const payloadCloud = pending.map(o => {
                    const p = { ...o, idcustomer: o.idCustomer || o.idcustomer || `CUST-RECOVERY-${o.id}`, syncstatus: 1 };
                    delete p.isArchived; delete p.idCustomer;
                    return p;
                });
                
                const chunkSize = 100;
                for (let i = 0; i < payloadCloud.length; i += chunkSize) {
                    const chunk = payloadCloud.slice(i, i + chunkSize);
                    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, { 
                        method: "POST", 
                        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates", "x-sacha-token": tokenPerangkat },
                        body: JSON.stringify(chunk) 
                    });
                    if (res.ok) await dbLokal.orders.where('id').anyOf(chunk.map(d => d.id)).modify({ syncstatus: 1 });
                }
            }

            if (deleted.length > 0) {
                for (let d of deleted) {
                    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${d.id}`, { 
                        method: "PATCH",
                        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat },
                        body: JSON.stringify({ syncstatus: -1, updated_at: new Date().toISOString() })
                    });
                    if (res.ok) await dbLokal.orders.where("id").equals(d.id).delete();
                }
            }
        } catch (error) { console.error("Gagal Auto-Sync:", error); }
    },

    // 4. MASTER BARANG: TAMBAH/EDIT
    simpanMasterBaru: async function(payload, isEditMode, onSuccess, onFailure) {
        const now = new Date().toISOString();
        try {
            if (isEditMode) {
                const dataLama = await dbLokal.master.filter(m => m.pusat === isEditMode.pusat && m.sarimbit === isEditMode.sarimbit && m.barang === isEditMode.barang && m.varian === isEditMode.varian && m.size === isEditMode.size).first();
                if (dataLama) {
                    await dbLokal.master.update(dataLama.id, { ...payload, updated_at: now });
                    if (navigator.onLine) await supabaseFetch(`/rest/v1/master?id=eq.${dataLama.id}`, { method: 'PATCH', body: JSON.stringify({ ...payload, updated_at: now }) });
                }
            } else {
                const newData = { id: generateNumericID(), ...payload, updated_at: now };
                await dbLokal.master.add(newData);
                if (navigator.onLine) await supabaseFetch(`/rest/v1/master`, { method: 'POST', body: JSON.stringify(newData) });
            }
            if (onSuccess) onSuccess();
        } catch (e) { if (onFailure) onFailure(e); }
    },

    // 5. MASTER BARANG: IMPORT EXCEL
    importMasterMassal: async function(dataArray, onSuccess, onFailure) {
        try {
            await dbLokal.master.bulkPut(dataArray); 
            if(navigator.onLine) {
                const chunkSize = 500;
                for (let i = 0; i < dataArray.length; i += chunkSize) {
                    await supabaseFetch('/rest/v1/master', { 
                        method: "POST", headers: { "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(dataArray.slice(i, i + chunkSize)) 
                    });
                }
            }
            if (onSuccess) onSuccess();
        } catch (e) { if (onFailure) onFailure(e); }
    },

    // 6. MASTER BARANG: HAPUS KOLEKSI
    hapusSarimbitMaster: async function(namaSarimbit, onSuccess, onFailure) {
        try {
            await dbLokal.master.where('sarimbit').equals(namaSarimbit).delete();
            if (navigator.onLine) await supabaseFetch(`/rest/v1/master?sarimbit=eq.${encodeURIComponent(namaSarimbit)}`, { method: "DELETE" });
            if (onSuccess) onSuccess(`Koleksi ${namaSarimbit} berhasil dihapus permanen!`);
        } catch(e) { if(onFailure) onFailure(e); }
    },

    // 7. ORDERAN: UPDATE FIELD SATUAN
    updateFieldKeSheet: async function(idCustomer, field, nilaiBersih, onSuccess, onFailure) {
        try {
            const now = new Date().toISOString();
            await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ [field]: nilaiBersih, updated_at: now, syncstatus: navigator.onLine ? 1 : 0 });
            
            if (navigator.onLine) {
                let body = { updated_at: now }; body[field] = nilaiBersih;
                const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?idcustomer=eq.${idCustomer}`, { 
                    method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify(body) 
                });
                if (!res.ok) await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ syncstatus: 0 });
            }
            if (onSuccess) onSuccess(); 
        } catch(e) { if(onFailure) onFailure(e); }
    },

    // 8. ORDERAN: HAPUS SATUAN / KESELURUHAN
    hapusSatuBaris: async function(idBaris, onSuccess) {
        const now = new Date().toISOString();
        await dbLokal.orders.where("id").equals(idBaris).modify({ syncstatus: -1, updated_at: now });
        if (navigator.onLine) {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${idBaris}`, { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify({ syncstatus: -1, updated_at: now }) });
            if (res.ok) await dbLokal.orders.where("id").equals(idBaris).delete();
        }
        if (onSuccess) onSuccess();
    },

    hapusDataCustomer: async function(idCustomer, onSuccess) {
        const now = new Date().toISOString();
        await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ syncstatus: -1, updated_at: now });
        if (navigator.onLine) {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?idcustomer=eq.${idCustomer}`, { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify({ syncstatus: -1, updated_at: now }) });
            if (res.ok) await dbLokal.orders.where("idcustomer").equals(idCustomer).delete();
        }
        if (onSuccess) onSuccess("Dihapus");
    },

    // 9. SETORAN PUSAT: SIMPAN & SINKRON
    simpanSetoranCloud: async function(idVarian, disetor) {
        try {
            const payload = { id: idVarian, disetor: Number(disetor), updated_at: new Date().toISOString(), syncstatus: navigator.onLine ? 1 : 0 };
            await dbLokal.setoran_pusat.put(payload);
            if (navigator.onLine) {
                const { syncstatus, ...dataCloud } = payload;
                await fetch(`${SUPABASE_URL}/rest/v1/setoran_pusat`, { method: "POST", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates", "x-sacha-token": tokenPerangkat }, body: JSON.stringify([dataCloud]) });
                await dbLokal.setoran_pusat.update(idVarian, { syncstatus: 1 });
            }
        } catch(e) { console.error(e); }
    },

    // 10. PEMBUKUAN: PROSES ARSIP & KUNCI OMSET
    prosesArsipSarimbit: async function(archivePayload, fSarimbit, onSuccess, onFailure) {
        try {
            const existing = await dbLokal.pembukuan.where('sarimbit').equals(fSarimbit).first();
            const headersJSON = { "Content-Type": "application/json", "Prefer": "return=representation" };

            // 1. Kunci Data di Tabel Pembukuan
            if (navigator.onLine) {
                if (existing) await supabaseFetch(`/rest/v1/pembukuan?id=eq.${existing.id}`, { method: 'PATCH', headers: headersJSON, body: JSON.stringify(archivePayload) });
                else { archivePayload.id = Date.now(); await supabaseFetch('/rest/v1/pembukuan', { method: 'POST', headers: headersJSON, body: JSON.stringify([archivePayload]) }); }
            } else { if (!existing) archivePayload.id = Date.now(); }

            if (existing) await dbLokal.pembukuan.update(existing.id, archivePayload);
            else await dbLokal.pembukuan.add(archivePayload);

            // 2. Sembunyikan (Soft-Delete) rincian Order
            const tNow = new Date().toISOString();
            if (navigator.onLine) await supabaseFetch(`/rest/v1/orders?sarimbit=eq.${encodeURIComponent(fSarimbit)}`, { method: 'PATCH', headers: headersJSON, body: JSON.stringify({ isarchived: true, updated_at: tNow }) });
            await dbLokal.orders.where('sarimbit').equals(fSarimbit).modify({ isarchived: true, syncstatus: navigator.onLine ? 1 : 0, updated_at: tNow });

            // 3. Hapus Master Barang
            if (navigator.onLine) await supabaseFetch(`/rest/v1/master?sarimbit=eq.${encodeURIComponent(fSarimbit)}`, { method: 'DELETE' });
            await dbLokal.master.where('sarimbit').equals(fSarimbit).delete();

            if (onSuccess) onSuccess();
        } catch (e) { if (onFailure) onFailure(e); }
    }
};

// ========================================================
// 7. SISTEM KTP PERANGKAT & REKAM JEJAK (AUDIT TRAIL)
// ========================================================

function initDeviceId() {
    let deviceId = localStorage.getItem('sarimbit_device_id');
    if (!deviceId) {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        let deviceName = prompt(`Sistem mendeteksi perangkat baru.\nBeri nama perangkat ini (Contoh: Kasir Depan):`, `${isMobile ? "HP" : "PC"}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`);
        if (!deviceName || deviceName.trim() === "") deviceName = `PC-${Date.now()}`;
        localStorage.setItem('sarimbit_device_id', deviceName);
        deviceId = deviceName;
    }
    return deviceId;
}

async function bersihkanLogLama() {
    try {
        const batasLogStr = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const batasSampahStr = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        await dbLokal.logs.where('time').below(batasLogStr).delete();
        await dbLokal.orders.filter(o => (o.isarchived === true || o.isArchived === true) && o.updated_at < batasSampahStr).delete();

        if (navigator.onLine) {
            try {
                await fetch(`${SUPABASE_URL}/rest/v1/logs?time=lt.${encodeURIComponent(batasLogStr)}`, { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-sacha-token": tokenPerangkat } });
                await fetch(`${SUPABASE_URL}/rest/v1/orders?syncstatus=eq.-1&updated_at=lt.${encodeURIComponent(batasSampahStr)}`, { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-sacha-token": tokenPerangkat } });
                await fetch(`${SUPABASE_URL}/rest/v1/orders?isarchived=eq.true&updated_at=lt.${encodeURIComponent(batasSampahStr)}`, { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-sacha-token": tokenPerangkat } });
            } catch (e) {}
        }
    } catch (e) {}
}

window.catatLog = async function(action, module, detail) {
    try {
        const logData = { id: generateNumericID(), action, module, detail, device: initDeviceId(), time: new Date().toISOString(), syncstatus: 0 };
        await dbLokal.logs.add(logData);

        if (navigator.onLine) {
            const { syncstatus, ...dataBersih } = logData;
            const res = await fetch(`${SUPABASE_URL}/rest/v1/logs`, { method: "POST", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify([dataBersih]) });
            if (res.ok) await dbLokal.logs.update(logData.id, { syncstatus: 1 });
        }
    } catch (e) {}
};

// ========================================================
// SUNTIKAN SUPABASE REALTIME WEBSOCKETS (TANPA HTML)
// ========================================================

function inisialisasiSupabaseRealtime() {
    const script = document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    
    script.onload = () => {
        const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

        function aktifkanRealtimeListener() {
            if (!navigator.onLine) return;
            supabaseClient
              .channel('public:orders')
              .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, payload => {
                  console.log("⚡ Perubahan Realtime dari HP terdeteksi:", payload);
                  if (typeof DatabaseAPI !== 'undefined') {
                      DatabaseAPI.getAllData((res) => {
                          if (typeof updateGlobalFilters === 'function') {
                              masterData = res.master || []; 
                              orderData = res.orders || [];
                              updateGlobalFilters();
                              if (document.getElementById('page-slip')?.classList.contains('active')) renderSlip();
                              if (document.getElementById('page-rekap')?.classList.contains('active')) renderRekap();
                          }
                      });
                  }
              })
              .subscribe(s => { if(s === 'SUBSCRIBED') console.log("🟢 Realtime Terhubung."); });
        }
        aktifkanRealtimeListener();
        window.addEventListener('online', () => setTimeout(aktifkanRealtimeListener, 2000));
    };
    document.head.appendChild(script);
}

document.addEventListener('DOMContentLoaded', () => {
    initDeviceId();      
    bersihkanLogLama();  
    inisialisasiSupabaseRealtime();
});
window.addEventListener('online', () => DatabaseAPI.syncOfflineData());