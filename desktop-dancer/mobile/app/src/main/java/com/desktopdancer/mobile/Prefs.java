package com.desktopdancer.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

/** App settings (shared by the settings screen, the overlay and the wallpaper). */
final class Prefs {
    static final String CHARACTER = "character";   // "asset:mannequin.vrm" or "lib:characters/x.vrm"
    static final String MOTION = "motion";
    static final String SCALE = "scale";           // overlay size, 0.25 .. 8
    static final String SPEED = "speed";
    static final String FPS = "fps";
    static final String BG = "bg";                 // wallpaper background color
    static final String WP_SCALE = "wpScale";      // wallpaper: character height / screen height
    static final String WP_X = "wpX";              // wallpaper: 0 = left .. 1 = right
    static final String WP_Y = "wpY";              // wallpaper: feet height from the bottom, share of the screen
    static final String OVERLAY_X = "overlayX";    // overlay window position (px), -1 = default
    static final String OVERLAY_Y = "overlayY";

    private Prefs() {}

    static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("dancer", Context.MODE_PRIVATE);
    }

    static String str(Context c, String k) {
        String def = CHARACTER.equals(k) ? "asset:mannequin.vrm" : MOTION.equals(k) ? "asset:sample-dance.vrma"
                : BG.equals(k) ? "#20242e" : "";
        return sp(c).getString(k, def);
    }

    static float num(Context c, String k) {
        float def;
        switch (k) {
            case SCALE: case SPEED: def = 1f; break;
            case FPS: def = 30f; break;
            case WP_SCALE: def = 0.55f; break;
            case WP_X: def = 0.5f; break;
            case WP_Y: def = 0.08f; break;
            default: def = -1f;
        }
        return sp(c).getFloat(k, def);
    }

    /** Settings as JSON for the settings page. */
    static JSONObject toJson(Context c) throws JSONException {
        JSONObject o = new JSONObject();
        o.put(CHARACTER, str(c, CHARACTER));
        o.put(MOTION, str(c, MOTION));
        o.put(BG, str(c, BG));
        for (String k : new String[] {SCALE, SPEED, FPS, WP_SCALE, WP_X, WP_Y}) o.put(k, num(c, k));
        return o;
    }

    /** Validated update from the settings page. Returns false for unknown keys / bad values. */
    static boolean set(Context c, String key, String json) {
        try {
            Object v = new JSONObject("{\"v\":" + json + "}").get("v");
            SharedPreferences.Editor e = sp(c).edit();
            switch (key) {
                case CHARACTER: case MOTION:
                    String s = String.valueOf(v);
                    if (!(s.startsWith("asset:") || s.startsWith("lib:")) || s.contains("..")) return false;
                    e.putString(key, s);
                    break;
                case BG:
                    String col = String.valueOf(v);
                    if (!col.matches("#[0-9a-fA-F]{6}")) return false;
                    e.putString(key, col);
                    break;
                case SCALE: e.putFloat(key, clamp(v, 0.25f, 8f)); break;
                case SPEED: e.putFloat(key, clamp(v, 0.25f, 3f)); break;
                case FPS: e.putFloat(key, clamp(v, 10f, 60f)); break;
                case WP_SCALE: e.putFloat(key, clamp(v, 0.05f, 2f)); break;
                case WP_X: e.putFloat(key, clamp(v, 0f, 1f)); break;
                case WP_Y: e.putFloat(key, clamp(v, 0f, 0.95f)); break;
                default: return false;
            }
            e.apply();
            return true;
        } catch (JSONException | ClassCastException ex) {
            return false;
        }
    }

    private static float clamp(Object v, float lo, float hi) {
        float f = ((Number) v).floatValue();
        return Math.max(lo, Math.min(hi, f));
    }
}
