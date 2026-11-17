'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novaMail', {
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    save: (input) => ipcRenderer.invoke('accounts:save', input),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    activate: (id) => ipcRenderer.invoke('accounts:activate', id),
    test: (input) => ipcRenderer.invoke('accounts:test', input),
  },
  mail: {
    folders: (accountId) => ipcRenderer.invoke('mail:folders', accountId),
    list: (accountId, mailbox, limit) => ipcRenderer.invoke('mail:list', accountId, mailbox, limit),
    cache: (accountId, mailbox) => ipcRenderer.invoke('mail:cache', accountId, mailbox),
    delete: (accountId, mailbox, uid) => ipcRenderer.invoke('mail:delete', accountId, mailbox, uid),
    markAllRead: (accountId, mailbox) => ipcRenderer.invoke('mail:markAllRead', accountId, mailbox),
    get: (accountId, mailbox, uid) => ipcRenderer.invoke('mail:get', accountId, mailbox, uid),
    flags: (accountId, mailbox, uid, seen) => ipcRenderer.invoke('mail:flags', accountId, mailbox, uid, seen),
    flag: (accountId, mailbox, uid, flagged) => ipcRenderer.invoke('mail:flag', accountId, mailbox, uid, flagged),
    saveAttachment: (accountId, mailbox, uid, index) => ipcRenderer.invoke('mail:attachment', accountId, mailbox, uid, index),
    send: (payload) => ipcRenderer.invoke('mail:send', payload),
  },
  app: {
    openNovaMail: () => ipcRenderer.invoke('app:openNovaMail'),
    info: () => ipcRenderer.invoke('app:info'),
    clearCache: (accountId) => ipcRenderer.invoke('app:clearCache', accountId),
    e2e: (report) => ipcRenderer.invoke('e2e:report', report),
  },
});
