(() => {
  "use strict";

  const databaseName = "drop-drafts";
  const storageName = "drafts";
  const localPrefix = "drop-drafts:";

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(storageName, {keyPath: "key"});
        store.createIndex("userId", "userId");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("草稿数据库暂时无法打开。"));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
  }

  function draftKey(userId, id) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("草稿缺少有效标识。");
    }
    return encodeURIComponent(userId) + ":" + id;
  }

  function indexedStore(database, userId) {
    function run(mode, action) {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storageName, mode);
        const store = transaction.objectStore(storageName);
        transaction.onabort = () => reject(transaction.error || new Error("草稿保存操作已中止。"));
        let result;
        transaction.oncomplete = () => resolve(result);
        action(store, (value) => { result = value; });
      });
    }

    return {
      all() {
        return run("readonly", (store, result) => {
          const request = store.index("userId").getAll(userId);
          request.onsuccess = () => result(request.result.map((record) => record.draft));
        });
      },
      put(draft) {
        return run("readwrite", (store, result) => {
          store.put({key: draftKey(userId, draft.id), userId, draft});
          result({persistent: true});
        });
      },
      remove(id) {
        return run("readwrite", (store) => {
          store.delete(draftKey(userId, id));
        });
      },
      clear() {
        return run("readwrite", (store) => {
          const request = store.index("userId").openCursor(userId);
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        });
      }
    };
  }

  function localStore(userId) {
    const key = localPrefix + encodeURIComponent(userId);
    function read() {
      return JSON.parse(window.localStorage.getItem(key) || "{}");
    }

    return {
      async all() {
        return Object.values(read());
      },
      async put(draft) {
        const id = draftKey(userId, draft.id);
        const drafts = read();
        drafts[id] = draft;
        const serialized = JSON.stringify(drafts, (_key, value) => {
          if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            throw new Error("此浏览器暂时无法保存录音草稿，请保持页面开启。");
          }
          return value;
        });
        window.localStorage.setItem(key, serialized);
        return {persistent: true};
      },
      async remove(id) {
        const drafts = read();
        delete drafts[draftKey(userId, id)];
        window.localStorage.setItem(key, JSON.stringify(drafts));
      },
      async clear() {
        window.localStorage.removeItem(key);
      }
    };
  }

  window.DropDrafts = {
    async open(userId) {
      if (typeof userId !== "string" || userId.length === 0) {
        throw new Error("保存草稿需要有效的用户标识。");
      }
      try {
        return indexedStore(await openDatabase(), userId);
      } catch (_error) {
        return localStore(userId);
      }
    }
  };
})();
