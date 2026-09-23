// ========================================================
// DATABASE ENGINE: NUMERIC ID SYNC (LAPTOP & CLOUD IDENTIK)
// ========================================================

const SUPABASE_URL = "https://dhrnbqitaxykmufucucv.supabase.co";
const SUPABASE_KEY = "sb_publishable_I0ehNCjUO9Y-FULSmMVPAg_3VlsLqL6";

// TAMBAHAN VVIP: Ambil Sertifikat dari memori browser
const tokenPerangkat = localStorage.getItem('sarimbit_vip_token') || 'TIDAK-ADA-SERTIFIKAT';

const dbLokal = new Dexie("SarimbitPro_DB");

// Versi 11: Penambahan Tabel Setoran Pusat
dbLokal.version(11).stores({
    orders: '++id, idcustomer, customer, sarimbit, syncstatus, isArchived, updated_at',
    master: '++id, pusat, sarimbit, barang, updated_at',
    pembukuan: '++id, sarimbit, isArchived, isPrinted, isInformed, updated_at',
    metadata: 'key',
    logs: '++id, action, module, detail, device, time, syncstatus',
    setoran_pusat: 'id, disetor, syncstatus, updated_at' // TABEL BARU UNTUK REKAP SETORAN
});
dbLokal.open().catch("UpgradeError", function (e) {
    console.warn("Bentrok struktur data terdeteksi. Melakukan reset otomatis...");
    // PERBAIKAN: Namanya sudah disamakan menjadi "SarimbitPro_DB"
    Dexie.delete("SarimbitPro_DB").then(() => {
        console.log("Database lama dibersihkan. Memuat ulang sistem...");
        location.reload();
    });
}).catch(function (e) {
    console.error("Gagal membuka database:", e.message);
});
// ========================================================

// Fungsi pembuat ID Angka unik berdasarkan waktu (milidetik) + angka acak
function generateNumericID() {
    return Date.now() + Math.floor(Math.random() * 1000);
}

// FUNGSI PENGHUBUNG CLOUD (Telah diperbaiki untuk mencegah Duplikasi Data / Type Mismatch)
async function supabaseFetch(endpoint, options = {}) {
    try {
        const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
            ...options,
            headers: { 
                "apikey": SUPABASE_KEY, 
                "Authorization": `Bearer ${SUPABASE_KEY}`, 
                "Content-Type": "application/json",
                "x-sacha-token": tokenPerangkat, // <-- TAMBAHAN VVIP
                ...options.headers
            }
        });
        
        if (!res.ok) return null;
        
        const textData = await res.text();
        if (!textData) return null;

        // PERBAIKAN FATAL: Memaksa Angka yang berubah jadi Teks dari Supabase untuk kembali menjadi Angka murni.
        // Ini akan mencegah Dexie.js menciptakan "Data Hantu" atau "Data Ganda"!
        return JSON.parse(textData, (key, value) => {
            // 'id' dihilangkan dari array utama agar bisa difilter secara khusus
            const kolomAngka = [
                'syncstatus', 'diskonNilai', 'jumlah', 
                'harga', 'total', 'berat', 'cicilan1', 
                'cicilan2', 'cicilan3', 'ongkir', 'dp', 
                'bayar', 'omset', 'disetor'
            ];

            // Pengecekan Khusus untuk 'id': 
            // Bedakan antara ID Angka (Tabel Orders) dan ID Teks (idVarian di Tabel Setoran Pusat)
            if (key === 'id' && value !== null && value !== "") {
                const nilaiAngka = Number(value);
                // Jika hasilnya BUKAN NaN (Not-a-Number), berarti murni angka, maka jadikan Number
                if (!isNaN(nilaiAngka)) {
                    return nilaiAngka;
                }
                // Jika ada hurufnya (seperti idVarian), biarkan tetap sebagai Teks (String)
                return value;
            }

            // Jika nama kolom ada di daftar atas, paksa ubah wujudnya kembali menjadi Angka (Number)
            if (kolomAngka.includes(key) && value !== null && value !== "") {
                return Number(value);
            }
            return value;
        });
        
    } catch (e) { 
        return null; 
    }
}
window.google = {
    script: {
        get run() { // PERBAIKAN: get run() mencetak memori baru di tiap pemanggilan
            return {
            withSuccessHandler: function(cb) { this.onSuccess = cb; return this; },
            withFailureHandler: function(cb) { this.onFailure = cb; return this; },

        // 1. AMBIL DATA & SINKRONISASI PINTAR (VERSI ANTI GHOST-DATA MASSAL & SATUAN)
        getAllData: async function() {
            try {
                let localMaster = await dbLokal.master.toArray();
                // REVISI: Mengunci kedua versi huruf isarchived agar akurat 100%
                let localOrders = await dbLokal.orders.filter(o => o.syncstatus !== -1 && o.isarchived !== true && o.isArchived !== true).toArray();
                let localPembukuan = await dbLokal.pembukuan.toArray(); 
                
                localOrders.sort((a, b) => {
                    const dateA = a.tanggal ? new Date(a.tanggal).getTime() : 0;
                    const dateB = b.tanggal ? new Date(b.tanggal).getTime() : 0;
                    // PERBAIKAN: Jika waktu kembar, urutkan berdasarkan ID
                    if (dateA === dateB) {
                        return a.id - b.id; 
                    }
                    return dateB - dateA;
                });
                
                if(this.onSuccess) this.onSuccess({ master: localMaster, orders: localOrders, pembukuan: localPembukuan });

                if (navigator.onLine) {
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

                  if (cloudOrders && cloudOrders.length > 0) {
                    const dataAktif = cloudOrders.filter(o => o.syncstatus !== -1);
                    const dataDihapusPusat = cloudOrders.filter(o => o.syncstatus === -1);

                    // PENGAMAN 3: PROTEKSI RACE CONDITION (Anti Data Lama Bangkit Kembali)
                    const pendingLokal = await dbLokal.orders.filter(o => o.syncstatus === 0 || o.syncstatus === -1).toArray();
                    const idPendingLokal = pendingLokal.map(o => o.id);

                    if (dataAktif.length > 0) {
                        // Abaikan sinkronisasi dari server jika data tersebut sedang dalam antrean diedit/dihapus oleh Admin lokal
                        const dataAktifAman = dataAktif.filter(o => !idPendingLokal.includes(o.id));
                        if (dataAktifAman.length > 0) {
                            await dbLokal.orders.bulkPut(dataAktifAman.map(o => ({...o, syncstatus: 1})));
                        }
                    }

                    if (dataDihapusPusat.length > 0) {
                        const idsToDel = dataDihapusPusat.map(o => o.id);
                        await dbLokal.orders.where('id').anyOf(idsToDel).delete();
                        console.log(`[Security Sync] Berhasil memusnahkan ${idsToDel.length} data hantu satuan.`);
                    }

                    const maxO = cloudOrders.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSyncOrder);
                    await dbLokal.metadata.put({ key: "last_sync_order", value: maxO });
                }

                 const lastSyncPembukuan = (await dbLokal.metadata.get("last_sync_pembukuan"))?.value || "1970-01-01T00:00:00Z";
                 let cloudPembukuan = [];
                 let offsetBuku = 0;
                 let keepFetchingBuku = true;
                 
                 while (keepFetchingBuku) {
                     const batchBuku = await supabaseFetch(`/rest/v1/pembukuan?select=*&updated_at=gt.${encodeURIComponent(lastSyncPembukuan)}&order=updated_at.asc&limit=${limitPerBatch}&offset=${offsetBuku}`);
                     if (batchBuku && batchBuku.length > 0) {
                         cloudPembukuan = cloudPembukuan.concat(batchBuku);
                         if (batchBuku.length < limitPerBatch) keepFetchingBuku = false;
                         else offsetBuku += limitPerBatch;
                     } else keepFetchingBuku = false;
                 }

                 if (cloudPembukuan && cloudPembukuan.length > 0) {
                    await dbLokal.pembukuan.bulkPut(cloudPembukuan);
                    const maxP = cloudPembukuan.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSyncPembukuan);
                    await dbLokal.metadata.put({ key: "last_sync_pembukuan", value: maxP });
                }

                // SINKRONISASI SETORAN PUSAT (Dari Cloud ke Lokal)
                const lastSyncSetoran = (await dbLokal.metadata.get("last_sync_setoran"))?.value || "1970-01-01T00:00:00Z";
                const cloudSetoran = await supabaseFetch(`/rest/v1/setoran_pusat?select=*&updated_at=gt.${encodeURIComponent(lastSyncSetoran)}`);
                if (cloudSetoran && cloudSetoran.length > 0) {
                    await dbLokal.setoran_pusat.bulkPut(cloudSetoran.map(s => ({...s, syncstatus: 1})));
                    const maxS = cloudSetoran.reduce((max, s) => s.updated_at > max ? s.updated_at : max, lastSyncSetoran);
                    await dbLokal.metadata.put({ key: "last_sync_setoran", value: maxS });
                    
                    // Ekspor data ke localStorage agar tampilan tabel Rekap UI langsung terbaca
                    let memoriSetoran = {};
                    const semuaSetoranLokal = await dbLokal.setoran_pusat.toArray();
                    semuaSetoranLokal.forEach(s => memoriSetoran[s.id] = s.disetor);
                    localStorage.setItem('DataSetoranPusat', JSON.stringify(memoriSetoran));
                }

                    // REVISI: Pastikan pembersihan lokal juga membaca huruf kecil dari Supabase
                    const daftarArsip = await dbLokal.pembukuan.filter(p => p.isarchived === true || p.isArchived === true).toArray();
                    const namaSarimbitArsip = daftarArsip.map(p => p.sarimbit);

                    if (namaSarimbitArsip.length > 0) {
                        await dbLokal.master.where('sarimbit').anyOf(namaSarimbitArsip).delete();
                        await dbLokal.orders.where('sarimbit').anyOf(namaSarimbitArsip).delete();
                        console.log(`[Security Sync] Berhasil membersihkan lokal data untuk sarimbit: ${namaSarimbitArsip.join(', ')}`);
                    }

                    localMaster = await dbLokal.master.toArray();
                    localOrders = await dbLokal.orders.filter(o => o.syncstatus !== -1 && o.isarchived !== true && o.isArchived !== true).toArray();
                    localPembukuan = await dbLokal.pembukuan.toArray(); 
                    
                    localOrders.sort((a, b) => {
                        const dateA = a.tanggal ? new Date(a.tanggal).getTime() : 0;
                        const dateB = b.tanggal ? new Date(b.tanggal).getTime() : 0;
                        // PERBAIKAN: Jika waktu kembar, urutkan berdasarkan ID
                        if (dateA === dateB) {
                            return a.id - b.id; 
                        }
                        return dateB - dateA;
                    });
                    
                    if(this.onSuccess) this.onSuccess({ master: localMaster, orders: localOrders, pembukuan: localPembukuan });
                }
            } catch(e) { console.error("Gagal Sinkronisasi:", e); }
        },
// 2. SIMPAN ORDERAN (DIPERBAIKI: PEMBERSIHAN DATA AGAR TIDAK NULL)
saveOrders: async function(items) {
    const now = new Date().toISOString();
    const baseId = Date.now(); // PERBAIKAN: Tangkap satu titik waktu mutlak
    
    // 1. PEMBERSIHAN DATA KETAT DI AWAL (Strict Type Casting)
    const dataWithId = items.map((it, idx) => ({
        ...it,
        id: it.id || (baseId + idx), // PERBAIKAN: ID dipastikan murni berurutan
        updated_at: now,
        syncstatus: 0,
        // Memastikan SEMUA kolom numeric sesuai skema benar-benar angka murni
        harga: Number(it.harga) || 0,
        jumlah: Number(it.jumlah) || 0,
        total: Number(it.total) || 0,
        berat: Number(it.berat) || 0,
        cicilan1: Number(it.cicilan1) || 0,
        cicilan2: Number(it.cicilan2) || 0,
        cicilan3: Number(it.cicilan3) || 0,
        ongkir: Number(it.ongkir) || 0,
        diskonNilai: Number(it.diskonNilai) || 0
    }));

    try {
        // Simpan ke memori lokal Dexie terlebih dahulu
        await dbLokal.orders.bulkPut(dataWithId);
        
        if (navigator.onLine) {
            const payloadCloud = dataWithId.map(item => {
                const { syncstatus, ...dataBersih } = item;
                return dataBersih;
            });

            const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
                method: "POST",
                headers: { 
                    "apikey": SUPABASE_KEY, 
                    "Authorization": `Bearer ${SUPABASE_KEY}`, 
                    "Content-Type": "application/json",
                    "Prefer": "resolution=merge-duplicates", // SOLUSI GANDA: Menimpa ID yang sama
                    "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                },
                body: JSON.stringify(payloadCloud)
            });
            
            if (res.ok) {
                const idsToUpdate = dataWithId.map(d => d.id);
                await dbLokal.orders.where('id').anyOf(idsToUpdate).modify({ syncstatus: 1 });
            } else {
                // TANGKAP ERROR SUPABASE SECARA EKSPLISIT AGAR KITA TAHU KENAPA DITOLAK
                const errorMsg = await res.text();
                console.error("Supabase menolak data (saveOrders):", errorMsg);
            }
        }
        if(this.onSuccess) this.onSuccess("Data Berhasil Disimpan!");
    } catch(e) { 
        console.error("Gagal kirim ke Cloud:", e);
        if(this.onSuccess) this.onSuccess("Tersimpan secara Offline."); 
    }
},
// 3. HAPUS 1 CUSTOMER FULL (SINKRON MULTI-DEVICE)
hapusDataCustomer: async function(idCustomer) {
    try {
        const now = new Date().toISOString();
        await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ syncstatus: -1, updated_at: now });
        
        if (navigator.onLine) {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?idcustomer=eq.${idCustomer}`, {
                method: "PATCH",
                headers: { 
                    "apikey": SUPABASE_KEY, 
                    "Authorization": `Bearer ${SUPABASE_KEY}`,
                    "Content-Type": "application/json",
                    "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                },
                body: JSON.stringify({ syncstatus: -1, updated_at: now })
            });
            
            if (res.ok) {
                await dbLokal.orders.where("idcustomer").equals(idCustomer).delete();
            }
        }
        if(this.onSuccess) this.onSuccess("Proses Hapus Berhasil!");
    } catch(e) { if(this.onFailure) this.onFailure(e); }
},
         // 4. HAPUS SATUAN BARANG DI DALAM ORDERAN (SINKRON MULTI-DEVICE)
         hapusSatuBaris: async function(idBaris) {
            try {
                const now = new Date().toISOString();
                await dbLokal.orders.where("id").equals(idBaris).modify({ syncstatus: -1, updated_at: now });
                
                if (navigator.onLine) {
                    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${idBaris}`, {
                        method: "PATCH",
                        headers: { 
                            "apikey": SUPABASE_KEY, 
                            "Authorization": `Bearer ${SUPABASE_KEY}`,
                            "Content-Type": "application/json",
                            "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                        },
                        body: JSON.stringify({ syncstatus: -1, updated_at: now })
                    });
                    
                    if (res.ok) {
                        await dbLokal.orders.where("id").equals(idBaris).delete();
                    }
                }
                if(this.onSuccess) this.onSuccess("Item Berhasil Dihapus!");
            } catch(e) { if(this.onFailure) this.onFailure(e); }
        },
// 4B. HAPUS KOLEKSI SARIMBIT DARI MASTER (MASSAL)
hapusSarimbitMaster: async function(namaSarimbit) {
    try {
        // Hapus di memori laptop
        await dbLokal.master.where('sarimbit').equals(namaSarimbit).delete();

        // Hapus permanen di server Supabase
        if (navigator.onLine) {
            await fetch(`${SUPABASE_URL}/rest/v1/master?sarimbit=eq.${encodeURIComponent(namaSarimbit)}`, {
                method: "DELETE",
                headers: { 
                    "apikey": SUPABASE_KEY, 
                    "Authorization": `Bearer ${SUPABASE_KEY}`,
                    "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                }
            });
        }
        
        if(this.onSuccess) this.onSuccess(`Koleksi ${namaSarimbit} berhasil dihapus permanen!`);
    } catch(e) {
        if(this.onFailure) this.onFailure(e);
    }
},
        // 5. UPDATE FIELD (EDIT CEPAT DI TABEL RINCIAN)
        updateFieldKeSheet: async function(idCustomer, field, nilai) {
            try {
                const now = new Date().toISOString();
                const kolomNumeric = ['harga', 'jumlah', 'total', 'berat', 'cicilan1', 'cicilan2', 'cicilan3', 'ongkir', 'diskonNilai'];
                
                // Pastikan nama field sesuai dengan skema (jangan dipaksa huruf kecil yang bisa merusak camelCase)
                let namaField = field;
                let nilaiBersih = nilai;

                // Paksa jadi angka murni jika masuk ke daftar kolom numeric Supabase
                if (kolomNumeric.includes(namaField)) {
                    nilaiBersih = Number(nilai) || 0;
                }

                // Update memori lokal dulu
                await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ [namaField]: nilaiBersih, updated_at: now, syncstatus: navigator.onLine ? 1 : 0 });
                
                if (navigator.onLine) {
                    let body = { updated_at: now }; 
                    body[namaField] = nilaiBersih;
                    
                    // Kita gunakan fetch manual di sini agar bisa menangkap pesan error asli dari Supabase
                    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?idcustomer=eq.${idCustomer}`, { 
                        method: "PATCH", 
                        headers: {
                            "apikey": SUPABASE_KEY, 
                            "Authorization": `Bearer ${SUPABASE_KEY}`,
                            "Content-Type": "application/json",
                            "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                        },
                        body: JSON.stringify(body) 
                    });

                    if (!res.ok) {
                        const errorMsg = await res.text();
                        console.error(`Supabase menolak update field ${namaField}:`, errorMsg);
                        // Jika ditolak, kembalikan status sync lokal ke 0 agar auto-sync mencoba menembakkannya lagi nanti
                        await dbLokal.orders.where("idcustomer").equals(idCustomer).modify({ syncstatus: 0 });
                    }
                }
                if (this.onSuccess) this.onSuccess(); 
            } catch(e) { 
                if(this.onFailure) this.onFailure(e); 
            }
        },

// 6. SINKRONISASI OFFLINE & PEMBUAT DATA GHOST
syncOfflineData: async function() {
    if (!navigator.onLine) return;

    try {
        const pending = await dbLokal.orders.filter(o => o.syncstatus === 0).toArray();
        const deleted = await dbLokal.orders.filter(o => o.syncstatus === -1).toArray();
        
        if (pending.length > 0) {
            const payloadCloud = pending.map(o => {
                // CETAK BIRU MUTLAK UNTUK ORDERAN (27 Kolom Seragam Sempurna)
                return {
                    id: o.id,
                    idcustomer: o.idCustomer || o.idcustomer || `CUST-RECOVERY-${o.id}`,
                    customer: o.customer || "",
                    telepon: o.telepon || "",
                    alamat: o.alamat || "",
                    pusat: o.pusat || "",
                    sarimbit: o.sarimbit || "",
                    barang: o.barang || "",
                    varian: o.varian || "",
                    size: o.size || "",
                    harga: Number(o.harga) || 0,
                    jumlah: Number(o.jumlah) || 0,
                    total: Number(o.total) || 0,
                    berat: Number(o.berat) || 0,
                    cicilan1: Number(o.cicilan1) || 0,
                    cicilan2: Number(o.cicilan2) || 0,
                    cicilan3: Number(o.cicilan3) || 0,
                    ongkir: Number(o.ongkir) || 0,
                    diskonNilai: Number(o.diskonNilai) || 0,
                    ekspedisi: o.ekspedisi || "",
                    resi: o.resi || "",
                    tanggal: o.tanggal || new Date().toISOString(),
                    toko: o.toko || "",
                    asal_order: o.asal_order || "", // TAMBAHAN: Sumber Penjualan
                    syncstatus: o.syncstatus !== undefined ? o.syncstatus : 1,
                    diskonTipe: o.diskonTipe || "none",
                    isarchived: (o.isArchived === true || o.isarchived === true),
                    updated_at: o.updated_at || new Date().toISOString()
                };
            });

            // CHUNKING: Kirim bertahap per 100 data agar meringankan beban server
            const chunkSize = 100;
            for (let i = 0; i < payloadCloud.length; i += chunkSize) {
                const chunk = payloadCloud.slice(i, i + chunkSize);
                
                const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, { 
                    method: "POST", 
                    headers: { 
                        "apikey": SUPABASE_KEY, 
                        "Authorization": `Bearer ${SUPABASE_KEY}`, 
                        "Content-Type": "application/json", 
                        "Prefer": "resolution=merge-duplicates",
                        "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                    },
                    body: JSON.stringify(chunk) 
                });
                
                if (res.ok) {
                    const idsToUpdate = chunk.map(d => d.id);
                    await dbLokal.orders.where('id').anyOf(idsToUpdate).modify({ syncstatus: 1 });
                } else {
                    const errorMsg = await res.text();
                    console.error(`Gagal Auto-Sync Batch ${i}:`, errorMsg);
                }
            }
        }

        if (deleted.length > 0) {
            for (let d of deleted) {
                const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${d.id}`, { 
                    method: "PATCH",
                    headers: { 
                        "apikey": SUPABASE_KEY, 
                        "Authorization": `Bearer ${SUPABASE_KEY}`,
                        "Content-Type": "application/json",
                        "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                    },
                    body: JSON.stringify({ syncstatus: -1, updated_at: new Date().toISOString() })
                });
                
                if (res.ok) {
                    await dbLokal.orders.where("id").equals(d.id).delete();
                }
            }
        }
    } catch (error) {
        console.error("Gagal Auto-Sync:", error);
    }
},
// 6B. SIMPAN & SINKRON SETORAN PUSAT KE CLOUD
simpanSetoranCloud: async function(idVarian, disetor) {
    try {
        const now = new Date().toISOString();
        const payload = { id: idVarian, disetor: Number(disetor), updated_at: now, syncstatus: navigator.onLine ? 1 : 0 };
        
        await dbLokal.setoran_pusat.put(payload);
        
        if (navigator.onLine) {
            const { syncstatus, ...dataCloud } = payload;
            await fetch(`${SUPABASE_URL}/rest/v1/setoran_pusat`, {
                method: "POST",
                headers: { 
                    "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, 
                    "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates",
                    "x-sacha-token": tokenPerangkat
                },
                body: JSON.stringify([dataCloud])
            });
            await dbLokal.setoran_pusat.update(idVarian, { syncstatus: 1 });
        }
        if(this.onSuccess) this.onSuccess();
    } catch(e) { console.error("Gagal simpan setoran ke cloud:", e); }
},

// ========================================================
// FUNGSI AMBIL DATA PEMBUKUAN (DENGAN SUNTIKAN OMSET)
// ========================================================
    getDataPembukuan: async function() {
        try {
            // REVISI: Data pesanan yang sudah diarsip WAJIB dikeluarkan agar omset aktif tidak ganda
            const orders = await dbLokal.orders.filter(o => o.syncstatus !== -1 && o.isarchived !== true && o.isArchived !== true).toArray();
            let localPembukuan = await dbLokal.pembukuan.toArray();

            if (navigator.onLine) {
                const lastSync = (await dbLokal.metadata.get("last_sync_pembukuan"))?.value || "1970-01-01T00:00:00Z";
                const cloudData = await supabaseFetch(`/rest/v1/pembukuan?select=*&updated_at=gt.${encodeURIComponent(lastSync)}`);
                if (cloudData && cloudData.length > 0) {
                    await dbLokal.pembukuan.bulkPut(cloudData);
                    const maxUpdate = cloudData.reduce((max, p) => p.updated_at > max ? p.updated_at : max, lastSync);
                    await dbLokal.metadata.put({ key: "last_sync_pembukuan", value: maxUpdate });
                    localPembukuan = await dbLokal.pembukuan.toArray(); 
                }
            }

            const summaryMap = {};
            
            localPembukuan.forEach(p => {
                summaryMap[p.sarimbit] = { 
                    totalOrder: Number(p.total) || 0,
                    totalOmset: Number(p.omset) || 0,
                    isPrinted: p.isPrinted || false, 
                    isInformed: p.isInformed || false, 
                    ...p 
                };
            });

            const orderGroup = {};
            orders.forEach(o => {
                if(!orderGroup[o.sarimbit]) orderGroup[o.sarimbit] = {};
                if(!orderGroup[o.sarimbit][o.idcustomer]) orderGroup[o.sarimbit][o.idcustomer] = [];
                orderGroup[o.sarimbit][o.idcustomer].push(o);
            });

            Object.keys(orderGroup).forEach(sarimbit => {
                let qtyAktif = 0;
                let omsetAktif = 0;
                let namaBrand = "";

                Object.values(orderGroup[sarimbit]).forEach(items => {
                    if (!namaBrand && items[0].pusat) namaBrand = items[0].pusat;
                    
                    const grossInvoice = items.reduce((sum, it) => sum + ((Number(it.jumlah)||0) * (Number(it.harga)||0)), 0);
                    const dTipe = items[0].diskonTipe || 'none';
                    const dNilai = Number(items[0].diskonNilai) || 0;
                    
                    let diskonInvoice = 0;
                    if (dTipe === 'persen') diskonInvoice = (grossInvoice * dNilai) / 100;
                    else if (dTipe === 'angka') diskonInvoice = dNilai;
                    
                    let netInvoice = grossInvoice - diskonInvoice;
                    if (netInvoice < 0) netInvoice = 0;

                    omsetAktif += netInvoice;
                    items.forEach(it => qtyAktif += (Number(it.jumlah)||0));
                });

                if (!summaryMap[sarimbit]) {
                    summaryMap[sarimbit] = {
                        sarimbit: sarimbit, isArchived: false, isPrinted: false, isInformed: false,
                        brand: namaBrand, close: "", ready: "", c1: "", c2: "", lunas: "", 
                        dp: 0, bayar: 0, statusKirim: "Langsung", statusAlamat: "Belum Lengkap"
                    };
                }
                
                summaryMap[sarimbit].totalOrder = qtyAktif;
                summaryMap[sarimbit].totalOmset = omsetAktif;
                if (!summaryMap[sarimbit].brand) summaryMap[sarimbit].brand = namaBrand;
            });

            const result = Object.values(summaryMap).sort((a, b) => a.sarimbit.localeCompare(b.sarimbit));
            if(this.onSuccess) this.onSuccess(result);

        } catch(e) { 
            console.error("Gagal sinkronisasi pembukuan:", e);
        }
    }
} // Penutup dari return {
} // Penutup dari get run() {
} // Penutup dari script: {
}; // Penutup dari window.google = {
    
window.addEventListener('online', () => window.google.script.run.syncOfflineData());
// ========================================================
// PENYEGAR OTOMATIS (AUTO-REFRESH CLOUD KE LOKAL)
// ========================================================
setInterval(() => {
    if (navigator.onLine && typeof window.google !== 'undefined') {
        window.google.script.run
            .withSuccessHandler(function(dataServer) {
                if (typeof tampilkanData === 'function' && document.getElementById('tableBody')) {
                    tampilkanData();
                }
                if (typeof loadPembukuan === 'function' && document.getElementById('pembukuanBody')) {
                    loadPembukuan();
                }
            })
            .getAllData(); 
    }
}, 5000); // Dipercepat menjadi 5 detik

// ========================================================
// 7. SISTEM KTP PERANGKAT & REKAM JEJAK (AUDIT TRAIL)
// ========================================================

// A. Fungsi Pengecek & Pembuat KTP Perangkat (Device ID)
function initDeviceId() {
    let deviceId = localStorage.getItem('sarimbit_device_id');
    
    if (!deviceId) {
        // Deteksi apakah pakai HP atau PC
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const prefix = isMobile ? "HP" : "PC";
        const randomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        // Minta Admin menamai perangkatnya saat pertama kali buka
        let deviceName = prompt(`Sistem mendeteksi perangkat baru.\nSilakan beri nama perangkat ini (Contoh: Kasir Depan, HP Bos):`, `${prefix}-${randomCode}`);
        
        if (!deviceName || deviceName.trim() === "") deviceName = `${prefix}-${randomCode}`;
        
        localStorage.setItem('sarimbit_device_id', deviceName);
        deviceId = deviceName;
    }
    return deviceId;
}

// B. Mesin Tukang Sapu Otomatis (Log & Sampah Supabase)
async function bersihkanLogLama() {
    try {
        // 1. Batas waktu untuk Log Aktivitas (14 Hari)
        const batasWaktuLog = new Date();
        batasWaktuLog.setDate(batasWaktuLog.getDate() - 14);
        const batasLogStr = batasWaktuLog.toISOString();

        // 2. Batas waktu untuk Data Ghost/Sampah/Arsip (7 Hari)
        const batasWaktuSampah = new Date();
        batasWaktuSampah.setDate(batasWaktuSampah.getDate() - 7);
        const batasSampahStr = batasWaktuSampah.toISOString();

        // Sapu log di memori laptop
        await dbLokal.logs.where('time').below(batasLogStr).delete();
        
        // Sapu data pesanan yang diarsipkan di memori laptop (> 7 Hari)
        await dbLokal.orders.filter(o => (o.isarchived === true || o.isArchived === true) && o.updated_at < batasSampahStr).delete();

        if (navigator.onLine) {
            try {
                // Eksekusi Pembersihan Log di Supabase (> 14 hari)
                await fetch(`${SUPABASE_URL}/rest/v1/logs?time=lt.${encodeURIComponent(batasLogStr)}`, {
                    method: "DELETE",
                    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-sacha-token": tokenPerangkat }
                });

                // Eksekusi Pembersihan Data Ghost (syncstatus -1) di Supabase (> 7 Hari)
                await fetch(`${SUPABASE_URL}/rest/v1/orders?syncstatus=eq.-1&updated_at=lt.${encodeURIComponent(batasSampahStr)}`, {
                    method: "DELETE",
                    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-sacha-token": tokenPerangkat }
                });
                
                // Eksekusi Pembersihan Permanen Data Arsip di Supabase (> 7 Hari)
                await fetch(`${SUPABASE_URL}/rest/v1/orders?isarchived=eq.true&updated_at=lt.${encodeURIComponent(batasSampahStr)}`, {
                    method: "DELETE",
                    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "x-sacha-token": tokenPerangkat }
                });
            } catch (netErr) {
                // Abaikan error jaringan di latar belakang agar tidak mengganggu operasional admin
            }
        }
    } catch (e) {
        // Abaikan error database lokal
    }
}

// Jalankan otomatis saat sistem dimuat
document.addEventListener('DOMContentLoaded', () => {
    initDeviceId();      // Siapkan KTP Perangkat
    bersihkanLogLama();  // Sapu bersih data log yang sudah kedaluwarsa
});

// C. Mesin Perekam Log (Bisa dipanggil dari mana saja)
window.catatLog = async function(action, module, detail) {
    try {
        const device = initDeviceId(); // Ambil nama perangkat yang sedang dipakai
        const timeStr = new Date().toISOString(); // Catat detik kejadian
        
        const logData = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            action: action,     // Misal: 'CREATE', 'UPDATE', 'DELETE', 'ARCHIVE'
            module: module,     // Misal: 'ORDER', 'MASTER', 'PEMBUKUAN'
            detail: detail,     // Penjelasan kejadian
            device: device,     // Direkam dari alat mana
            time: timeStr,      // Waktu rekam
            syncstatus: 0       // 0 = Baru di laptop, 1 = Sudah di Server Cloud
        };

        // 1. Simpan diam-diam ke memori laptop/HP (Dexie)
        await dbLokal.logs.add(logData);

        // 2. Langsung lempar ke Server Supabase jika internet menyala
        if (navigator.onLine) {
            const { syncstatus, ...dataBersih } = logData; // Buang status lokal sebelum dikirim
            
            const res = await fetch(`${SUPABASE_URL}/rest/v1/logs`, {
                method: "POST",
                headers: { 
                    "apikey": SUPABASE_KEY, 
                    "Authorization": `Bearer ${SUPABASE_KEY}`, 
                    "Content-Type": "application/json",
                    "x-sacha-token": tokenPerangkat // <-- TAMBAHAN VVIP
                },
                body: JSON.stringify([dataBersih])
            });

            if (res.ok) {
                // Jika sukses diterima Server, ubah status jadi 1
                await dbLokal.logs.update(logData.id, { syncstatus: 1 });
            }
        }
    } catch (e) {
        console.error("Gagal merekam aktivitas ke dalam log:", e);
    }
};