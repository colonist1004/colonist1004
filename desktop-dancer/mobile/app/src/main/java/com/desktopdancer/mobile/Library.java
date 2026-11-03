package com.desktopdancer.mobile;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Characters (.vrm) and dances (.vrma): built-in samples in the APK plus files the user added. */
final class Library {
    static final String[][] SAMPLES = {
        {"characters", "mannequin.vrm", "마네킹 (기본)"},
        {"motions", "sample-dance.vrma", "샘플 춤 (기본)"},
    };

    private Library() {}

    static File root(Context c) {
        return new File(c.getFilesDir(), "library");
    }

    static File dir(Context c, String kind) {
        File d = new File(root(c), kind);
        d.mkdirs();
        return d;
    }

    /** id ("asset:x" / "lib:kind/x") -> URL relative to assets/web/dancer.html (same origin). */
    static String url(String id) {
        if (id.startsWith("asset:")) return "samples/" + id.substring(6);
        if (id.startsWith("lib:")) return "/library/" + id.substring(4);
        return null;
    }

    static boolean exists(Context c, String id) {
        if (id.startsWith("asset:")) return true;
        return id.startsWith("lib:") && !id.contains("..") && new File(root(c), id.substring(4)).isFile();
    }

    static JSONArray list(Context c, String kind) throws JSONException {
        String ext = "characters".equals(kind) ? ".vrm" : ".vrma";
        JSONArray a = new JSONArray();
        for (String[] s : SAMPLES) {
            if (s[0].equals(kind)) a.put(new JSONObject().put("id", "asset:" + s[1]).put("name", s[2]));
        }
        File[] files = dir(c, kind).listFiles();
        if (files != null) {
            Arrays.sort(files);
            for (File f : files) {
                if (f.getName().toLowerCase().endsWith(ext)) {
                    String n = f.getName();
                    a.put(new JSONObject().put("id", "lib:" + kind + "/" + n).put("name", n.substring(0, n.length() - ext.length())));
                }
            }
        }
        return a;
    }

    /** Slider tweaks made in the PC app: <name>.custom.json next to the character, if imported. */
    static JSONObject custom(Context c, String characterId) {
        if (!characterId.startsWith("lib:characters/")) return null;
        String n = characterId.substring("lib:characters/".length());
        File f = new File(dir(c, "characters"), n.replaceAll("\\.vrm$", "") + ".custom.json");
        if (!f.isFile() || f.length() > 64 * 1024) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int r = in.read(b, off, b.length - off);
                if (r < 0) break;
                off += r;
            }
            return new JSONObject(new String(b, 0, off, StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return null;
        }
    }
}
