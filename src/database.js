// ========================================================
// DATABASE ENGINE: NUMERIC ID SYNC & OFFLINE FIRST (TAURI + SUPABASE)
// ========================================================

const SUPABASE_URL = "https://dhrnbqitaxykmufucucv.supabase.co";
const SUPABASE_KEY = "sb_publishable_I0ehNCjUO9Y-FULSmMVPAg_3VlsLqL6";

const tokenPerangkat = localStorage.getItem('sarimbit_vip_token') || 'TIDAK-ADA-SERTIFIKAT';

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

function generateNumericID() {
    return Date.now() + Math.floor(Math.random() * 1000);
}

// Sensor Pintar Pengecek Internet Nyata
async function cekInternetAktif() {
    if (!navigator.onLine) return false;
    try {
        await fetch('https://www.google.com/favicon.ico', { mode: 'no-cors', cache: 'no-store' });
        return true;
    } catch (e) { return false; }
}

async function supabaseFetch(endpoint, options = {}) {
    try {
        if (!navigator.onLine) return null;
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

window.DatabaseAPI = {
    getAllData: async function(onSuccess, onFailure) {
        try {
            // 1. RENDER LOKAL TERLEBIH DAHULU (INSTAN!)
            let localMaster = await dbLokal.master.toArray();
            let localOrders = await dbLokal.orders.filter(o => o.syncstatus !== -1 && o.isarchived !== true && o.isArchived !== true).toArray();
            let localPembukuan = await dbLokal.pembukuan.toArray(); 
            
            localOrders.sort((a, b) => {
                const dateA = a.tanggal ? new Date(a.tanggal).getTime() : 0;
                const dateB = b.tanggal ? new Date(b.tanggal).getTime() : 0;
                return dateA === dateB ? a.id - b.id : dateB - dateA;
            });
            
            if (onSuccess) onSuccess({ master: localMaster, orders: localOrders, pembukuan: localPembukuan });

            // 2. SINKRONISASI CLOUD DIBELAKANG LAYAR (JIKA ONLINE NYATA)
            const isOnline = await cekInternetAktif();
            if (isOnline) {
                await this.syncOfflineData();

                const lastSyncMaster = (await dbLokal.metadata.get("last_sync_master"))?.value || "1970-01-01T00:00:00Z";
                const cloudMaster = await supabaseFetch(`/rest/v1/master?select=*&updated_at=gt.${encodeURIComponent(lastSyncMaster)}&limit=5000`);
                if (cloudMaster && cloudMaster.length > 0) {
                    await dbLokal.master.bulkPut(cloudMaster);
                    const maxM = cloudMaster.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSyncMaster);
                    await dbLokal.metadata.put({ key: "last_sync_master", value: maxM });
                }

                const lastSyncOrder = (await dbLokal.metadata.get("last_sync_order"))?.value || "1970-01-01T00:00:00Z";
                let cloudOrders = [];
                let offsetOrder = 0;
                let keepFetchingOrder = true;
                
                while (keepFetchingOrder) {
                    const batch = await supabaseFetch(`/rest/v1/orders?select=*&updated_at=gt.${encodeURIComponent(lastSyncOrder)}&order=updated_at.asc&limit=1000&offset=${offsetOrder}`);
                    if (batch && batch.length > 0) {
                        cloudOrders = cloudOrders.concat(batch);
                        if (batch.length < 1000) keepFetchingOrder = false;
                        else offsetOrder += 1000;
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

                const lastSyncPembukuan = (await dbLokal.metadata.get("last_sync_pembukuan"))?.value || "1970-01-01T00:00:00Z";
                const cloudPembukuan = await supabaseFetch(`/rest/v1/pembukuan?select=*&updated_at=gt.${encodeURIComponent(lastSyncPembukuan)}`);
                if (cloudPembukuan && cloudPembukuan.length > 0) {
                    await dbLokal.pembukuan.bulkPut(cloudPembukuan);
                    const maxP = cloudPembukuan.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSyncPembukuan);
                    await dbLokal.metadata.put({ key: "last_sync_pembukuan", value: maxP });
                }

                // 3. RENDER ULANG JIKA ADA PERUBAHAN DARI CLOUD
                localMaster = await dbLokal.master.toArray();
                localOrders = await dbLokal.orders.filter(o => o.syncstatus !== -1 && o.isarchived !== true && o.isArchived !== true).toArray();
                localPembukuan = await dbLokal.pembukuan.toArray(); 
                localOrders.sort((a, b) => {
                    const dateA = a.tanggal ? new Date(a.tanggal).getTime() : 0;
                    const dateB = b.tanggal ? new Date(b.tanggal).getTime() : 0;
                    return dateA === dateB ? a.id - b.id : dateB - dateA;
                });
                if (onSuccess) onSuccess({ master: localMaster, orders: localOrders, pembukuan: localPembukuan });
            }
        } catch(e) { console.error("Sinkronisasi gagal, menggunakan data lokal:", e); }
    },

    saveOrders: async function(items, onSuccess, onFailure) {
        const now = new Date().toISOString();
        const baseId = Date.now(); 
        const dataWithId = items.map((it, idx) => ({
            ...it, id: it.id || (baseId + idx), updated_at: now, syncstatus: 0,
            harga: Number(it.harga) || 0, jumlah: Number(it.jumlah) || 0, total: Number(it.total) || 0,
            berat: Number(it.berat) || 0, cicilan1: Number(it.cicilan1) || 0, cicilan2: Number(it.cicilan2) || 0,
            cicilan3: Number(it.cicilan3) || 0, ongkir: Number(it.ongkir) || 0, diskonNilai: Number(it.diskonNilai) || 0
        }));

        try {
            await dbLokal.orders.bulkPut(dataWithId); 
            if (await cekInternetAktif()) {
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

    syncOfflineData: async function() {
        if (!(await cekInternetAktif())) return;
        try {
            const pending = await dbLokal.orders.filter(o => o.syncstatus === 0).toArray();
            const deleted = await dbLokal.orders.filter(o => o.syncstatus === -1).toArray();
            if (pending.length > 0) {
                const payloadCloud = pending.map(o => {
                    const p = { ...o, idcustomer: o.idCustomer || o.idcustomer || `CUST-RECOVERY-${o.id}`, syncstatus: 1 };
                    delete p.isArchived; delete p.idCustomer; return p;
                });
                for (let i = 0; i < payloadCloud.length; i += 100) {
                    const chunk = payloadCloud.slice(i, i + 100);
                    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, { 
                        method: "POST", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates", "x-sacha-token": tokenPerangkat }, body: JSON.stringify(chunk) 
                    });
                    if (res.ok) await dbLokal.orders.where('id').anyOf(chunk.map(d => d.id)).modify({ syncstatus: 1 });
                }
            }
            if (deleted.length > 0) {
                for (let d of deleted) {
                    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${d.id}`, { 
                        method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify({ syncstatus: -1, updated_at: new Date().toISOString() })
                    });
                    if (res.ok) await dbLokal.orders.where("id").equals(d.id).delete();
                }
            }
        } catch (e) { console.error("Gagal Auto-Sync:", e); }
    },

    simpanMasterBaru: async function(payload, isEditMode, onSuccess, onFailure) {
        const now = new Date().toISOString();
        try {
            if (isEditMode) {
                const dataLama = await dbLokal.master.filter(m => m.pusat === isEditMode.pusat && m.sarimbit === isEditMode.sarimbit && m.barang === isEditMode.barang && m.varian === isEditMode.varian && m.size === isEditMode.size).first();
                if (dataLama) {
                    await dbLokal.master.update(dataLama.id, { ...payload, updated_at: now });
                    if (await cekInternetAktif()) await supabaseFetch(`/rest/v1/master?id=eq.${dataLama.id}`, { method: 'PATCH', body: JSON.stringify({ ...payload, updated_at: now }) });
                }
            } else {
                const newData = { id: generateNumericID(), ...payload, updated_at: now };
                await dbLokal.master.add(newData);
                if (await cekInternetAktif()) await supabaseFetch(`/rest/v1/master`, { method: 'POST', body: JSON.stringify(newData) });
            }
            if (onSuccess) onSuccess();
        } catch (e) { if (onFailure) onFailure(e); }
    },

    importMasterMassal: async function(dataArray, onSuccess, onFailure) {
        try {
            await dbLokal.master.bulkPut(dataArray); 
            if(await cekInternetAktif()) {
                for (let i = 0; i < dataArray.length; i += 500) {
                    await supabaseFetch('/rest/v1/master', { method: "POST", headers: { "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(dataArray.slice(i, i + 500)) });
                }
            }
            if (onSuccess) onSuccess();
        } catch (e) { if (onFailure) onFailure(e); }
    },

    hapusSarimbitMaster: async function(namaSarimbit, onSuccess, onFailure) {
        try {
            await dbLokal.master.where('sarimbit').equals(namaSarimbit).delete();
            if (await cekInternetAktif()) await supabaseFetch(`/rest/v1/master?sarimbit=eq.${encodeURIComponent(namaSarimbit)}`, { method: "DELETE" });
            if (onSuccess) onSuccess(`Koleksi ${namaSarimbit} berhasil dihapus permanen!`);
        } catch(e) { if(onFailure) onFailure(e); }
    },

    updateFieldKeSheet: async function(idCustomer, field, nilaiBersih, onSuccess, onFailure) {
        try {
            const now = new Date().toISOString();
            const isOnline = await cekInternetAktif();
            await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ [field]: nilaiBersih, updated_at: now, syncstatus: isOnline ? 1 : 0 });
            if (isOnline) {
                let body = { updated_at: now }; body[field] = nilaiBersih;
                const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?idcustomer=eq.${idCustomer}`, { 
                    method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify(body) 
                });
                if (!res.ok) await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ syncstatus: 0 });
            }
            if (onSuccess) onSuccess(); 
        } catch(e) { if(onFailure) onFailure(e); }
    },

    hapusSatuBaris: async function(idBaris, onSuccess) {
        const now = new Date().toISOString();
        const isOnline = await cekInternetAktif();
        await dbLokal.orders.where("id").equals(idBaris).modify({ syncstatus: -1, updated_at: now });
        if (isOnline) {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${idBaris}`, { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify({ syncstatus: -1, updated_at: now }) });
            if (res.ok) await dbLokal.orders.where("id").equals(idBaris).delete();
        }
        if (onSuccess) onSuccess();
    },

    hapusDataCustomer: async function(idCustomer, onSuccess) {
        const now = new Date().toISOString();
        const isOnline = await cekInternetAktif();
        await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ syncstatus: -1, updated_at: now });
        if (isOnline) {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?idcustomer=eq.${idCustomer}`, { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-sacha-token": tokenPerangkat }, body: JSON.stringify({ syncstatus: -1, updated_at: now }) });
            if (res.ok) await dbLokal.orders.where("idcustomer").equals(idCustomer).delete();
        }
        if (onSuccess) onSuccess("Dihapus");
    },

    prosesArsipSarimbit: async function(archivePayload, fSarimbit, onSuccess, onFailure) {
        try {
            const existing = await dbLokal.pembukuan.where('sarimbit').equals(fSarimbit).first();
            const headersJSON = { "Content-Type": "application/json", "Prefer": "return=representation" };
            const isOnline = await cekInternetAktif();

            if (isOnline) {
                if (existing) await supabaseFetch(`/rest/v1/pembukuan?id=eq.${existing.id}`, { method: 'PATCH', headers: headersJSON, body: JSON.stringify(archivePayload) });
                else { archivePayload.id = Date.now(); await supabaseFetch('/rest/v1/pembukuan', { method: 'POST', headers: headersJSON, body: JSON.stringify([archivePayload]) }); }
            } else { if (!existing) archivePayload.id = Date.now(); }

            if (existing) await dbLokal.pembukuan.update(existing.id, archivePayload);
            else await dbLokal.pembukuan.add(archivePayload);

            const tNow = new Date().toISOString();
            if (isOnline) await supabaseFetch(`/rest/v1/orders?sarimbit=eq.${encodeURIComponent(fSarimbit)}`, { method: 'PATCH', headers: headersJSON, body: JSON.stringify({ isarchived: true, updated_at: tNow }) });
            await dbLokal.orders.where('sarimbit').equals(fSarimbit).modify({ isarchived: true, syncstatus: isOnline ? 1 : 0, updated_at: tNow });

            if (isOnline) await supabaseFetch(`/rest/v1/master?sarimbit=eq.${encodeURIComponent(fSarimbit)}`, { method: 'DELETE' });
            await dbLokal.master.where('sarimbit').equals(fSarimbit).delete();

            if (onSuccess) onSuccess();
        } catch (e) { if (onFailure) onFailure(e); }
    }
};

function initDeviceId() {
    let deviceId = localStorage.getItem('sarimbit_device_id');
    if (!deviceId) {
        deviceId = `PC-${Date.now()}`;
        localStorage.setItem('sarimbit_device_id', deviceId);
    }
    return deviceId;
}

async function bersihkanLogLama() {
    try {
        const batasLogStr = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const batasSampahStr = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        await dbLokal.logs.where('time').below(batasLogStr).delete();
        await dbLokal.orders.filter(o => (o.isarchived === true || o.isArchived === true) && o.updated_at < batasSampahStr).delete();
    } catch (e) {}
}

window.catatLog = async function(action, module, detail) {
    try {
        const logData = { id: generateNumericID(), action, module, detail, device: initDeviceId(), time: new Date().toISOString(), syncstatus: 0 };
        await dbLokal.logs.add(logData);
    } catch (e) {}
};

async function inisialisasiSupabaseRealtime() {
    // PENGAMANAN: Jangan coba eksekusi jika offline
    if (!(await cekInternetAktif())) {
        console.warn("Offline: Supabase Realtime ditunda.");
        return;
    }

    const script = document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    
    script.onload = () => {
        try {
            if (typeof supabase === 'undefined') return;
            const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

            function aktifkanRealtimeListener() {
                if (!navigator.onLine) return;
                supabaseClient
                  .channel('public:orders')
                  .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, payload => {
                      if (typeof DatabaseAPI !== 'undefined') {
                          DatabaseAPI.getAllData((res) => {
                              if (typeof updateGlobalFilters === 'function') {
                                  if (typeof masterData !== 'undefined') masterData = res.master || []; 
                                  if (typeof orderData !== 'undefined') orderData = res.orders || [];
                                  updateGlobalFilters();
                                  if (document.getElementById('page-slip')?.classList.contains('active')) renderSlip();
                                  if (document.getElementById('page-rekap')?.classList.contains('active')) renderRekap();
                              }
                          });
                      }
                  })
                  .subscribe();
            }
            aktifkanRealtimeListener();
        } catch (e) { console.error("Gagal inisialisasi Realtime:", e); }
    };
    document.head.appendChild(script);
}

document.addEventListener('DOMContentLoaded', () => {
    initDeviceId();      
    bersihkanLogLama();  
    inisialisasiSupabaseRealtime();
});