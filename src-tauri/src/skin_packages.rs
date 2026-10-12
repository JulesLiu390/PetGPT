//! Portable, normalized layered skins. LayerDiff is an import format, never a runtime dependency.
use crate::{
    database::{
        skins::{CreateSkinData, Skin},
        Database,
    },
    DbState,
};
use image::{imageops, ImageReader, RgbaImage};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager, State};

const FORMAT: &str = "petgpt-layered-skin";
const MAX_LAYERS: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub name: String,
    pub file: String,
    pub origin: [u32; 2],
    pub size: [u32; 2],
    pub z: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Animation {
    pub breathing: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub canvas: [u32; 2],
    pub layers: Vec<Layer>,
    pub animation: Animation,
    pub preview: String,
}

#[derive(Deserialize)]
struct LayerDiff {
    frame_size: [u32; 2],
    parts: IndexMap<String, Part>,
}

#[derive(Deserialize)]
struct Part {
    xyxy: [u32; 4],
    depth_median: f64,
}

fn read_json(path: &Path) -> Result<String, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("Skin metadata exceeds 1 MB".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

// Only relative files contained in the selected package may be imported, including symlinks.
fn asset(root: &Path, file: &str) -> Result<PathBuf, String> {
    if file.is_empty()
        || file.contains(['\\', ':'])
        || Path::new(file)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("Invalid skin asset path: {file}"));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("Missing skin folder {}: {e}", root.display()))?;
    let path = root.join(file);
    let path = path
        .canonicalize()
        .map_err(|e| format!("Missing asset {}: {e}", path.display()))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(format!("Asset is outside the skin directory: {file}"));
    }
    Ok(path)
}

fn validate(manifest: &Manifest) -> Result<(), String> {
    if manifest.format != FORMAT || manifest.version != 1 {
        return Err("Unsupported skin format or version (expected petgpt-layered-skin v1)".into());
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 200 {
        return Err("Skin name must contain 1–200 bytes".into());
    }
    if manifest.canvas.iter().any(|&n| n == 0 || n > 4096)
        || manifest.layers.is_empty()
        || manifest.layers.len() > MAX_LAYERS
    {
        return Err("Skin requires a canvas up to 4096×4096 and 1–64 layers".into());
    }
    let mut names = HashSet::new();
    let mut pixels = 0u64;
    for layer in &manifest.layers {
        if layer.name.trim().is_empty() || !names.insert(&layer.name) {
            return Err("Layer names must be nonempty and unique".into());
        }
        for axis in 0..2 {
            if layer.size[axis] == 0
                || u64::from(layer.origin[axis]) + u64::from(layer.size[axis])
                    > u64::from(manifest.canvas[axis])
            {
                return Err(format!("Layer is outside canvas: {}", layer.name));
            }
        }
        pixels += u64::from(layer.size[0]) * u64::from(layer.size[1]);
    }
    if pixels > 64 * 1024 * 1024 {
        return Err("Skin textures exceed 64 megapixels".into());
    }
    Ok(())
}

fn read_png(path: &Path, expected: [u32; 2]) -> Result<RgbaImage, String> {
    let mut reader = ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    if reader.format() != Some(image::ImageFormat::Png) {
        return Err(format!("Layer must be PNG: {}", path.display()));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| e.to_string())?;
    if [img.width(), img.height()] != expected {
        return Err(format!(
            "Wrong image dimensions for {}: expected {}×{}",
            path.display(),
            expected[0],
            expected[1]
        ));
    }
    Ok(img.into_rgba8())
}

fn find_metadata(source: &Path) -> Result<PathBuf, String> {
    if source.is_file() {
        return Ok(source.to_path_buf());
    }
    let standard = source.join("skin.json");
    if standard.is_file() {
        return Ok(standard);
    }
    // Selecting the UUID image directory also works.
    let sibling = source.with_extension("psd.json");
    if sibling.is_file() {
        return Ok(sibling);
    }
    let candidates: Vec<_> = fs::read_dir(source)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.to_string_lossy().ends_with(".psd.json"))
        .collect();
    match candidates.as_slice() {
        [path] => Ok(path.clone()),
        [] => Err("No skin.json or LayerDiff *.psd.json found in this directory".into()),
        _ => Err("Multiple LayerDiff characters found; select one *.psd.json file".into()),
    }
}

/// A source package resolved for import: the manifest to write and the image behind each layer.
struct Plan {
    manifest: Manifest,
    sources: Vec<PathBuf>,
    full_canvas: bool,
}

/// Reads and checks a source package without decoding images or writing anything.
fn plan(source: &Path, name: Option<&str>) -> Result<Plan, String> {
    let metadata = find_metadata(source)?;
    let root = metadata.parent().ok_or("Missing source directory")?;
    let json = read_json(&metadata)?;
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let (mut manifest, image_root, full_canvas) = if value.get("format").is_some() {
        let manifest: Manifest =
            serde_json::from_str(&json).map_err(|e| format!("Invalid skin manifest: {e}"))?;
        (manifest, root.to_path_buf(), false)
    } else {
        let data: LayerDiff =
            serde_json::from_str(&json).map_err(|e| format!("Invalid LayerDiff metadata: {e}"))?;
        let filename = metadata
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid metadata filename")?;
        let stem = filename
            .strip_suffix(".psd.json")
            .ok_or("Select LayerDiff's *.psd.json metadata")?;
        let folder = root.join(stem);
        let mut parts: Vec<_> = data.parts.into_iter().collect();
        if parts.iter().any(|(_, p)| !p.depth_median.is_finite()) {
            return Err("Invalid layer depth".into());
        }
        // Stable sort matches the PSD: far to near, original part order breaks ties.
        parts.sort_by(|a, b| b.1.depth_median.total_cmp(&a.1.depth_median));
        let mut layers = Vec::new();
        for (z, (name, part)) in parts.into_iter().enumerate() {
            let [x, y, right, bottom] = part.xyxy;
            let size = [
                right.checked_sub(x).ok_or("Invalid layer bounds")?,
                bottom.checked_sub(y).ok_or("Invalid layer bounds")?,
            ];
            layers.push(Layer {
                file: format!("{name}.png"),
                name,
                origin: [x, y],
                size,
                z: z as i32,
            });
        }
        (
            Manifest {
                format: FORMAT.into(),
                version: 1,
                name: "LayerDiff Character".into(),
                author: None,
                description: Some("Imported from LayerDiff".into()),
                canvas: data.frame_size,
                layers,
                animation: Animation { breathing: true },
                preview: "preview.png".into(),
            },
            // LayerDiff writes part images to a folder named after the metadata; some copies keep
            // them beside it instead.
            if folder.is_dir() {
                folder
            } else {
                root.to_path_buf()
            },
            true,
        )
    };
    if let Some(name) = name {
        manifest.name = name.trim().to_string();
    }
    validate(&manifest)?;
    manifest.layers.sort_by_key(|l| l.z);
    let sources = manifest
        .layers
        .iter()
        .map(|layer| asset(&image_root, &layer.file))
        .collect::<Result<_, _>>()?;
    Ok(Plan {
        manifest,
        sources,
        full_canvas,
    })
}

/// Writes a self-contained package into an empty staging directory. Does not modify the source.
fn normalize(source: &Path, destination: &Path, name: Option<&str>) -> Result<Manifest, String> {
    let Plan {
        mut manifest,
        sources,
        full_canvas,
    } = plan(source, name)?;
    fs::create_dir_all(destination.join("layers")).map_err(|e| e.to_string())?;
    let mut preview = RgbaImage::new(manifest.canvas[0], manifest.canvas[1]);
    for (index, (layer, path)) in manifest.layers.iter_mut().zip(&sources).enumerate() {
        let img = read_png(
            path,
            if full_canvas {
                manifest.canvas
            } else {
                layer.size
            },
        )?;
        let cropped = if full_canvas {
            imageops::crop_imm(
                &img,
                layer.origin[0],
                layer.origin[1],
                layer.size[0],
                layer.size[1],
            )
            .to_image()
        } else {
            img
        };
        // Metadata defines the meaningful crop. Preserve alpha; faint painted edges are intentional.
        layer.file = format!("layers/{index:03}.png");
        layer.z = index as i32;
        cropped
            .save(destination.join(&layer.file))
            .map_err(|e| e.to_string())?;
        imageops::overlay(
            &mut preview,
            &cropped,
            i64::from(layer.origin[0]),
            i64::from(layer.origin[1]),
        );
    }
    if !preview.pixels().any(|p| p[3] > 8) {
        return Err("Skin has no visible pixels".into());
    }
    manifest.preview = "preview.png".into();
    preview
        .save(destination.join(&manifest.preview))
        .map_err(|e| e.to_string())?;
    fs::write(
        destination.join("skin.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(manifest)
}

fn install(db: &Database, skins: &Path, source: &Path, name: Option<&str>) -> Result<Skin, String> {
    let staging = skins.join(format!(".import-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let manifest = normalize(source, &staging, name)?;
        let skin = db
            .create_skin(CreateSkinData {
                name: manifest.name,
                author: manifest.author,
                description: manifest.description,
                moods: Some(vec!["normal".into()]),
                is_builtin: false,
            })
            .map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&staging, skins.join(&skin.id)) {
            let _ = db.delete_skin(&skin.id);
            return Err(error.to_string());
        }
        Ok(skin)
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

#[tauri::command]
pub async fn import_layered_skin(
    app: AppHandle,
    db: State<'_, DbState>,
    source_path: String,
    name: Option<String>,
) -> Result<Skin, String> {
    let skins = crate::get_skins_dir(&app)?;
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        install(&db, &skins, Path::new(&source_path), name.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Checks a source the way import will, so missing layer images show up before importing.
#[tauri::command]
pub async fn inspect_layered_skin(source_path: String) -> Result<serde_json::Value, String> {
    let checked = tauri::async_runtime::spawn_blocking(move || plan(Path::new(&source_path), None))
        .await
        .map_err(|e| e.to_string())??;
    // Only LayerDiff layers are full-canvas images.
    Ok(serde_json::json!({
        "name": checked.manifest.name,
        "layers": checked.manifest.layers.len(),
        "layerDiff": checked.full_canvas,
    }))
}

pub fn export_package(source: &Path, export_dir: &Path) -> Result<String, String> {
    // A unique directory prevents overwriting an earlier export or the active skin itself.
    let target = export_dir.join(format!("skin-{}", uuid::Uuid::new_v4()));
    if let Err(error) = normalize(&source.join("skin.json"), &target, None) {
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }
    Ok(target.join("skin.json").to_string_lossy().into())
}

#[derive(Debug, Serialize)]
struct EyeLine {
    center: [f64; 2],
    angle: f64,
}

// LayerDiff keeps both eyes in one layer. The line through their centroids lets blinking squeeze
// perpendicular to a tilted face instead of shearing it.
fn eye_line_from_alpha(img: &RgbaImage, origin: [u32; 2]) -> Option<EyeLine> {
    let (w, h) = img.dimensions();
    let columns: Vec<u64> = (0..w)
        .map(|x| (0..h).map(|y| u64::from(img.get_pixel(x, y)[3])).sum())
        .collect();
    let centroid = |from: u32, to: u32| {
        let (mut mass, mut sx, mut sy) = (0u64, 0f64, 0f64);
        for x in from..to {
            for y in 0..h {
                let a = u64::from(img.get_pixel(x, y)[3]);
                mass += a;
                sx += a as f64 * (f64::from(x) + 0.5);
                sy += a as f64 * (f64::from(y) + 0.5);
            }
        }
        (mass > 0).then(|| (sx / mass as f64, sy / mass as f64, mass))
    };
    let (cx, cy, total) = centroid(0, w)?;
    // Split at the widest transparent gap in the central band; without one, assume a level face.
    let (mut split, mut widest, mut run) = (None, 0, 0);
    for x in w / 5..w * 4 / 5 {
        run = if columns[x as usize] < 255 { run + 1 } else { 0 };
        if run > widest {
            widest = run;
            split = Some(x + 1 - run + run / 2);
        }
    }
    let angle = split
        .and_then(|s| {
            let (lx, ly, left) = centroid(0, s)?;
            let (rx, ry, right) = centroid(s, w)?;
            (left * 10 >= total && right * 10 >= total)
                .then(|| (ry - ly).atan2(rx - lx).to_degrees().clamp(-30.0, 30.0))
        })
        .unwrap_or(0.0);
    Some(EyeLine {
        center: [f64::from(origin[0]) + cx, f64::from(origin[1]) + cy],
        angle,
    })
}

fn eye_line(root: &Path, manifest: &Manifest) -> Result<Option<EyeLine>, String> {
    let Some(layer) = manifest.layers.iter().find(|l| l.name == "eyewhite") else {
        return Ok(None);
    };
    let img = read_png(&asset(root, &layer.file)?, layer.size)?;
    Ok(eye_line_from_alpha(&img, layer.origin))
}

/// Layered skins shipped with the app, under `src-tauri/assets/skins/<dir>`. Their database
/// records are seeded by name at startup.
pub struct BuiltinSkin {
    pub name: &'static str,
    pub dir: &'static str,
}

pub const BUILTIN_SKINS: &[BuiltinSkin] = &[BuiltinSkin {
    name: "LayerDiff Character",
    dir: "layerdiff-character",
}];

/// Directory holding a skin's layered package, if it has one.
pub fn layered_root(app: &AppHandle, skin: &Skin) -> Result<Option<PathBuf>, String> {
    if skin.is_builtin {
        let Some(builtin) = BUILTIN_SKINS.iter().find(|b| b.name == skin.name) else {
            return Ok(None);
        };
        let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
        // Development builds may run before resources are copied next to the binary.
        return Ok([resource, PathBuf::from(env!("CARGO_MANIFEST_DIR"))]
            .into_iter()
            .map(|base| base.join("assets/skins").join(builtin.dir))
            .find(|root| root.join("skin.json").is_file()));
    }
    // IDs are used as directory names only after checking the database and their UUID form.
    uuid::Uuid::parse_str(&skin.id).map_err(|e| e.to_string())?;
    let root = crate::get_skins_dir(app)?.join(&skin.id);
    Ok(root.join("skin.json").is_file().then_some(root))
}

fn load_layered(root: &Path) -> Result<(Manifest, PathBuf), String> {
    let manifest: Manifest =
        serde_json::from_str(&read_json(&root.join("skin.json"))?).map_err(|e| e.to_string())?;
    validate(&manifest)?;
    for layer in &manifest.layers {
        asset(root, &layer.file)?;
    }
    let preview = asset(root, &manifest.preview)?;
    Ok((manifest, preview))
}

#[tauri::command]
pub fn get_skin_appearance(
    app: AppHandle,
    db: State<DbState>,
    skin_id: String,
    mood: Option<String>,
) -> Result<serde_json::Value, String> {
    let skin = db
        .get_skin_by_id(&skin_id)
        .map_err(|e| e.to_string())?
        .ok_or("Skin no longer exists")?;
    if let Some(root) = layered_root(&app, &skin)? {
        let (manifest, preview) = load_layered(&root)?;
        // Blink rigging is optional: an unreadable eye layer leaves the character static, not missing.
        let eye_line = eye_line(&root, &manifest).ok().flatten();
        return Ok(
            serde_json::json!({ "kind": "layered", "manifest": manifest, "basePath": root, "previewPath": preview, "eyeLine": eye_line }),
        );
    }
    if skin.is_builtin {
        return Err("Built-in skin package is missing".into());
    }
    let root = crate::get_skins_dir(&app)?.join(&skin.id);
    let moods = skin.moods.unwrap_or_else(|| vec!["normal".into()]);
    let requested = mood.unwrap_or_else(|| "normal".into());
    let index = moods.iter().position(|m| *m == requested).unwrap_or(0);
    for ext in ["png", "gif", "jpg", "jpeg", "webp"] {
        if let Ok(path) = asset(&root, &format!("{index}.{ext}")) {
            return Ok(serde_json::json!({ "kind": "image", "path": path }));
        }
    }
    Err("Skin image is missing".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::pets::{CreatePetData, UpdatePetData};
    use serde_json::json;

    #[test]
    fn layered_skin_asset_scope_allows_app_data_without_exposing_other_dotfiles() {
        // Use Tauri's real path resolver and scope matcher, not an HTTP mock.
        let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = "com.petgpt.asset-scope-test".into();
        context.config_mut().app.security = config.app.security;
        let app = tauri::test::mock_builder().build(context).unwrap();
        let root = app.path().app_data_dir().unwrap();
        let scope = app.asset_protocol_scope();
        assert!(scope.is_allowed(root.join("skins/test/preview.png")));
        assert!(scope.is_allowed(root.join("skins/test/layers/000.png")));
        #[cfg(unix)]
        {
            let old_scope = tauri::scope::fs::Scope::new(
                &app, &tauri::utils::config::FsScope::AllowedPaths(vec!["**".into()]),
            ).unwrap();
            let hidden = std::env::temp_dir().join(".petgpt-scope-test/preview.png");
            assert!(!old_scope.is_allowed(&hidden));
            assert!(!scope.is_allowed(&hidden));
            assert!(!scope.is_allowed(root.join(".unrelated-secret")));
        }
    }

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("petgpt-skin-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(root: &Path) -> PathBuf {
        let directory = root.join("sample");
        fs::create_dir_all(&directory).unwrap();
        let mut back = RgbaImage::new(8, 8);
        let mut front = RgbaImage::new(8, 8);
        back.put_pixel(3, 4, image::Rgba([255, 0, 0, 255]));
        front.put_pixel(3, 4, image::Rgba([0, 0, 255, 128]));
        back.save(directory.join("back.png")).unwrap();
        front.save(directory.join("front.png")).unwrap();
        let metadata = root.join("sample.psd.json");
        fs::write(
            &metadata,
            json!({"frame_size": [8,8], "parts": {
                "front": {"xyxy": [3,4,5,6], "depth_median": 0.1},
                "back": {"xyxy": [2,3,6,7], "depth_median": 0.9}
            }})
            .to_string(),
        )
        .unwrap();
        metadata
    }

    #[test]
    fn layered_skin_import_crops_preserves_alpha_and_roundtrips() {
        let tmp = Temp::new();
        let source = fixture(&tmp.0);
        let output = tmp.0.join("normalized");
        let m = normalize(&source, &output, Some("Test skin")).unwrap();
        assert_eq!(m.name, "Test skin");
        assert_eq!(m.layers[0].name, "back");
        assert_eq!(m.layers[1].origin, [3, 4]);
        let front = image::open(output.join(&m.layers[1].file))
            .unwrap()
            .to_rgba8();
        assert_eq!(front.dimensions(), (2, 2));
        assert_eq!(front.get_pixel(0, 0)[3], 128);
        let preview = image::open(output.join("preview.png")).unwrap().to_rgba8();
        assert_eq!(preview.get_pixel(0, 0)[3], 0);
        let pixel = preview.get_pixel(3, 4);
        // image's floating-point source-over may truncate an opaque result to alpha 254.
        assert!(pixel[0].abs_diff(127) <= 1 && pixel[2].abs_diff(128) <= 1 && pixel[3] >= 254, "{pixel:?}");
        let exported = export_package(&output, &tmp.0).unwrap();
        let imported = tmp.0.join("reimported");
        let m2 = normalize(Path::new(&exported), &imported, None).unwrap();
        assert_eq!(
            serde_json::to_value(m).unwrap(),
            serde_json::to_value(m2).unwrap()
        );
        assert_eq!(
            preview,
            image::open(imported.join("preview.png"))
                .unwrap()
                .to_rgba8()
        );
        // Folder selection resolves both the root output directory and UUID image directory.
        assert_eq!(find_metadata(&tmp.0).unwrap(), source);
        assert_eq!(find_metadata(&tmp.0.join("sample")).unwrap(), source);
    }

    #[test]
    fn layered_skin_failure_rolls_back_files_and_database() {
        let tmp = Temp::new();
        let source = fixture(&tmp.0);
        let skins = tmp.0.join("skins");
        fs::create_dir(&skins).unwrap();
        let db = Database::new(tmp.0.join("db.sqlite")).unwrap();
        fs::remove_file(tmp.0.join("sample/front.png")).unwrap();
        assert!(install(&db, &skins, &source, None).is_err());
        assert!(db.get_all_skins().unwrap().is_empty());
        assert_eq!(fs::read_dir(&skins).unwrap().count(), 0);
    }

    #[test]
    fn layered_skin_imports_layerdiff_images_kept_beside_metadata() {
        let tmp = Temp::new();
        let source = fixture(&tmp.0);
        for file in ["back.png", "front.png"] {
            fs::rename(tmp.0.join("sample").join(file), tmp.0.join(file)).unwrap();
        }
        fs::remove_dir(tmp.0.join("sample")).unwrap();
        // Folder selection resolves the same metadata and images.
        assert_eq!(plan(&tmp.0, None).unwrap().manifest.layers.len(), 2);
        let m = normalize(&source, &tmp.0.join("normalized"), None).unwrap();
        assert_eq!(m.layers[0].name, "back");
        assert_eq!(m.layers[1].origin, [3, 4]);
    }

    #[test]
    fn layered_skin_inspection_names_the_missing_image() {
        let tmp = Temp::new();
        let source = fixture(&tmp.0);
        fs::remove_file(tmp.0.join("sample/front.png")).unwrap();
        let error = plan(&source, None).err().unwrap();
        let missing = tmp.0.canonicalize().unwrap().join("sample/front.png");
        assert!(error.contains(&missing.display().to_string()), "{error}");
    }

    #[test]
    fn layered_skin_rejects_bad_assets_bounds_versions_and_ambiguous_directories() {
        let tmp = Temp::new();
        let source = fixture(&tmp.0);
        let output = tmp.0.join("normalized");
        let m = normalize(&source, &output, None).unwrap();
        for file in [
            "../sample/back.png",
            "/etc/passwd",
            "C:\\secret.png",
            "layers/../../back.png",
        ] {
            assert!(asset(&output, file).is_err());
        }
        let mut invalid = m.clone();
        invalid.version = 2;
        assert!(validate(&invalid).is_err());
        invalid = m.clone();
        invalid.layers[0].origin[0] = u32::MAX;
        assert!(validate(&invalid).is_err());
        invalid = m.clone();
        invalid.layers[1].name = invalid.layers[0].name.clone();
        assert!(validate(&invalid).is_err());
        invalid = m;
        invalid.layers[0].file = "../sample/back.png".into();
        fs::write(
            output.join("skin.json"),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert!(normalize(&output, &tmp.0.join("invalid"), None).is_err());
        fs::copy(source, tmp.0.join("another.psd.json")).unwrap();
        assert!(find_metadata(&tmp.0).unwrap_err().contains("Multiple"));
    }

    #[cfg(unix)]
    #[test]
    fn layered_skin_rejects_symlinks_escaping_package() {
        let tmp = Temp::new();
        fixture(&tmp.0);
        std::os::unix::fs::symlink(tmp.0.join("sample/back.png"), tmp.0.join("outside.png"))
            .unwrap();
        // A link inside the package pointing to a parent asset must not be followed.
        fs::write(tmp.0.join("secret.png"), "outside").unwrap();
        std::os::unix::fs::symlink(tmp.0.join("secret.png"), tmp.0.join("sample/escape.png"))
            .unwrap();
        assert!(asset(&tmp.0.join("sample"), "escape.png").is_err());
    }

    #[test]
    fn layered_skin_binding_survives_restart_and_deletion_restores_default() {
        let tmp = Temp::new();
        let path = tmp.0.join("db.sqlite");
        let db = Database::new(path.clone()).unwrap();
        let source = fixture(&tmp.0);
        let skins = tmp.0.join("skins");
        fs::create_dir(&skins).unwrap();
        let skin = install(&db, &skins, &source, None).unwrap();
        let data: CreatePetData =
            serde_json::from_value(json!({"name":"Assistant", "skinId": skin.id})).unwrap();
        let pet = db.create_pet(data).unwrap();
        let data: UpdatePetData = serde_json::from_value(json!({"name":"Renamed"})).unwrap();
        assert_eq!(
            db.update_pet(&pet.id, data).unwrap().unwrap().skin_id,
            Some(skin.id.clone())
        );
        drop(db);
        let db = Database::new(path).unwrap();
        assert_eq!(db.get_all_pets().unwrap()[0].skin_id, Some(skin.id.clone()));
        let clear: UpdatePetData = serde_json::from_value(json!({"skinId":""})).unwrap();
        assert_eq!(
            db.update_pet(&pet.id, clear).unwrap().unwrap().skin_id,
            None
        );
        let bind: UpdatePetData = serde_json::from_value(json!({"skinId": skin.id})).unwrap();
        db.update_pet(&pet.id, bind).unwrap();
        db.delete_skin(&skin.id).unwrap();
        assert_eq!(db.get_pet_by_id(&pet.id).unwrap().unwrap().skin_id, None);
        let stale: UpdatePetData = serde_json::from_value(json!({"skinId": skin.id})).unwrap();
        assert!(db.update_pet(&pet.id, stale).is_err());
    }

    #[test]
    fn layered_skin_migration_preserves_existing_assistants() {
        let tmp = Temp::new();
        let path = tmp.0.join("db.sqlite");
        let db = Database::new(path.clone()).unwrap();
        let pet = db
            .create_pet(
                serde_json::from_value(json!({"name": "Existing", "appearance": "unchanged"}))
                    .unwrap(),
            )
            .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute("ALTER TABLE pets DROP COLUMN skin_id", [])
            .unwrap();
        drop(db);
        let db = Database::new(path).unwrap();
        let restored = db.get_pet_by_id(&pet.id).unwrap().unwrap();
        assert_eq!(restored.appearance.as_deref(), Some("unchanged"));
        assert_eq!(restored.skin_id, None);
    }

    #[test]
    fn builtin_skins_ship_valid_rigged_packages() {
        for builtin in BUILTIN_SKINS {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/skins").join(builtin.dir);
            let (manifest, _) = load_layered(&root).unwrap();
            assert_eq!(manifest.name, builtin.name);
            assert!(eye_line(&root, &manifest).unwrap().is_some());
        }
    }

    #[test]
    fn startup_replaces_retired_builtin_skins_with_bundled_ones() {
        let tmp = Temp::new();
        let db = Database::new(tmp.0.join("db.sqlite")).unwrap();
        let retired = db
            .create_skin(CreateSkinData {
                name: "Glitch".into(),
                author: None,
                description: None,
                moods: None,
                is_builtin: true,
            })
            .unwrap();
        let pet = db
            .create_pet(serde_json::from_value(json!({"name": "A", "skinId": retired.id})).unwrap())
            .unwrap();
        crate::initialize_builtin_skins(&db);
        crate::initialize_builtin_skins(&db);
        let skins = db.get_all_skins_with_hidden().unwrap();
        let names: Vec<_> = skins.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, BUILTIN_SKINS.iter().map(|b| b.name).collect::<Vec<_>>());
        assert!(skins.iter().all(|s| s.is_builtin));
        assert_eq!(db.get_pet_by_id(&pet.id).unwrap().unwrap().skin_id, None);
    }

    #[test]
    fn eye_line_follows_the_tilt_between_both_eyes() {
        let mut img = RgbaImage::new(40, 20);
        for (x0, y0) in [(2, 4), (28, 10)] {
            for x in x0..x0 + 8 {
                for y in y0..y0 + 4 {
                    img.put_pixel(x, y, image::Rgba([255, 255, 255, 255]));
                }
            }
        }
        let line = eye_line_from_alpha(&img, [100, 200]).unwrap();
        assert!((line.angle - 6f64.atan2(26.0).to_degrees()).abs() < 0.01, "{line:?}");
        assert_eq!(line.center, [119.0, 209.0]);
        // A single visible eye has no measurable line; blinking then stays level.
        let mut single = RgbaImage::new(40, 20);
        single.put_pixel(20, 5, image::Rgba([255, 255, 255, 255]));
        assert_eq!(eye_line_from_alpha(&single, [0, 0]).unwrap().angle, 0.0);
        assert!(eye_line_from_alpha(&RgbaImage::new(4, 4), [0, 0]).is_none());
    }

    #[test]
    fn layered_skin_real_layerdiff_sample() {
        let tmp = Temp::new();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../layerdiff_output");
        let output = tmp.0.join("skin");
        let manifest = normalize(&source, &output, Some("LayerDiff sample")).unwrap();
        assert_eq!(manifest.canvas, [1024, 1024]);
        assert_eq!(manifest.layers.len(), 17);
        assert_eq!(manifest.layers.first().unwrap().name, "back hair");
        assert_eq!(manifest.layers.last().unwrap().name, "front hair");
        assert_eq!(manifest.layers.last().unwrap().origin, [409, 61]);
        let preview = image::open(output.join("preview.png")).unwrap().to_rgba8();
        assert_eq!(preview.get_pixel(0, 0)[3], 0);
        assert!(preview.pixels().filter(|p| p[3] > 127).count() > 100_000);
        let eyes = eye_line(&output, &manifest).unwrap().unwrap();
        assert!(eyes.angle.abs() < 30.0 && eyes.center[0] > 462.0 && eyes.center[0] < 532.0, "{eyes:?}");
        println!("Eye line: {eyes:?}");
        if let Ok(path) = std::env::var("PETGPT_SKIN_TEST_PREVIEW") {
            fs::copy(output.join("preview.png"), path).unwrap();
        }
        if let Ok(path) = std::env::var("PETGPT_SKIN_TEST_EXPORT_DIR") {
            println!("Sample package: {}", export_package(&output, Path::new(&path)).unwrap());
        }
    }
}
