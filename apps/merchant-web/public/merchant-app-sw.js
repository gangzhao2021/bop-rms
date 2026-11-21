/* global importScripts */
// Live v15 2026-11-10: Home (/app) and the other /app pages reloaded while the connection is down
// show the same offline page as the staff pages, from the same worker (see /operations/sw.js). It
// sits at the top level only so its scope can be "/app" itself; it covers nothing else.
importScripts("/operations/sw.js");
