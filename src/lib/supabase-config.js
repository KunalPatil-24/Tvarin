/*
 * Tvarin — Supabase config (shared by the options page and service worker).
 * The anon key is a PUBLIC key (safe to ship in the extension). It only allows
 * what Row-Level Security permits; the Gemini key stays server-side.
 */
const SUPABASE_URL = "https://ftoadktwfffrqmktusgl.supabase.co";

// Supabase "anon / public" key (safe to ship — RLS-gated; not the service_role key).
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0b2Fka3R3ZmZmcnFta3R1c2dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3NDU3MTIsImV4cCI6MjEwMTMyMTcxMn0.s8kDaSg7jQjqlAY4ErgmaNqkivaXhwFU2eD9B-Xu2Bg";

// Where the "Applications" button sends users — the hosted dashboard.
// Swap to your custom domain (e.g. https://tvarin.com) once you own it.
const DASHBOARD_URL = "https://reliable-swan-82425d.netlify.app/";
