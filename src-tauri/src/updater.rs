//! 应用内更新检查 —— 只回答「有没有新版本、去哪下」，不下载、不安装。
//!
//! 刻意不使用 `tauri-plugin-updater`：本应用未签名未公证，自动替换 `.app`
//! bundle 会撞上 Gatekeeper 与 macOS 13+ 的 App Management 保护，而 updater
//! 的 minisign 签名并不能替代 Apple 的 codesign。所以这里只比较版本号，
//! 把下载地址交给前端引导用户手动安装。

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;
use tauri::AppHandle;

/// 列出 release 而不是用 `/releases/latest`：本仓库至今发布的每个版本都标记为
/// prerelease，而 `/releases/latest` 会把 prerelease 和 draft 一起排除，对这个
/// 仓库恒定返回 404。所以这里自己取列表挑版本号最高的那个。
const RELEASES_API: &str =
    "https://api.github.com/repos/JulesLiu390/PetGPT/releases?per_page=30";
const RELEASES_PAGE: &str = "https://github.com/JulesLiu390/PetGPT/releases";
/// GitHub 拒绝没有 User-Agent 的 API 请求。
const UPDATE_USER_AGENT: &str = concat!("PetGPT-UpdateCheck/", env!("CARGO_PKG_VERSION"));
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    latest_version: String,
    has_update: bool,
    /// 目标 release 是否标记为 prerelease。本项目目前只发 prerelease，
    /// 所以不能据此过滤，只能让界面标注出来。
    prerelease: bool,
    release_url: String,
    notes: String,
    pub_date: String,
    /// 当前架构对应的 DMG 直链。找不到匹配资产时为空字符串，
    /// 前端应退回 `release_url`（非 macOS 平台就是这种情况）。
    asset_url: String,
    asset_name: String,
    asset_size: u64,
    checked_at: i64,
}

/// 截取 tag 里版本号开始的位置。
///
/// 实际用过的 tag 形状包括 `v1.2.3`、`app-v1.2.3`、
/// `PetGPT_0.3.0_alpha_Steins_Gate`、`Alpha_Release_PetGPT_v0.1.2_alpha`，
/// 所以要找的是第一个 `<数字>.<数字>` 形状 —— 只认「第一个数字」会被
/// `PetGPT2_v1.0` 这种名字里的 `2` 骗到。完全没有数字时返回空串，
/// 后续按 0.0.0 处理：宁可漏报也不要误报更新。
fn normalize_version(raw: &str) -> &str {
    let text = raw.trim();
    let bytes = text.as_bytes();
    for index in 0..bytes.len() {
        let starts_a_number = bytes[index].is_ascii_digit()
            && (index == 0 || !bytes[index - 1].is_ascii_digit());
        if !starts_a_number {
            continue;
        }
        let mut end = index;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end + 1 < bytes.len() && bytes[end] == b'.' && bytes[end + 1].is_ascii_digit() {
            return &text[index..];
        }
    }
    match text.find(|c: char| c.is_ascii_digit()) {
        Some(index) => &text[index..],
        None => "",
    }
}

/// 拆成 (三段数字, 后缀)。
///
/// 每段只取开头的连续数字，所以 `0.3.2_alpha` 能正确读成 0.3.2 ——
/// 整段 parse 会在 `2_alpha` 上失败并归零，把 0.3.2 误读成 0.3.0。
/// 数字核心之后剩下的一切都是后缀，按 SemVer 预发布对待；
/// build metadata (`+...`) 先剥掉，它不参与比较。
fn parse_version(raw: &str) -> ([u64; 3], String) {
    let text = normalize_version(raw)
        .split('+')
        .next()
        .unwrap_or("");

    let mut numbers = [0u64; 3];
    let mut rest = text;
    for slot in 0..3 {
        let digits_end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        if digits_end == 0 {
            break;
        }
        // 纯数字串只会因溢出而 parse 失败；此时归 0，宁可漏报也不要误报。
        numbers[slot] = rest[..digits_end].parse().unwrap_or(0);
        rest = &rest[digits_end..];
        // 只有下一段也以数字开头时才继续吃这个点号
        match rest.strip_prefix('.') {
            Some(next) if next.starts_with(|c: char| c.is_ascii_digit()) => rest = next,
            _ => break,
        }
    }

    let suffix = rest
        .trim_start_matches(|c: char| c == '-' || c == '_' || c == '.')
        .to_string();
    (numbers, suffix)
}

/// SemVer 的预发布规则：带预发布标识的版本**低于**同号正式版，
/// 所以 `0.5.0-beta` 不会盖过 `0.5.0`。
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let (left_numbers, left_pre) = parse_version(left);
    let (right_numbers, right_pre) = parse_version(right);
    match left_numbers.cmp(&right_numbers) {
        Ordering::Equal => match (left_pre.is_empty(), right_pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => left_pre.cmp(&right_pre),
        },
        other => other,
    }
}

/// DMG 文件名由 `scripts/create-dmg.sh` / `create-dmg-intel.sh` 决定：
/// `PetGPT_<version>_aarch64.dmg` 与 `PetGPT_<version>_x64.dmg`。
fn asset_suffix_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("_aarch64.dmg"),
        ("macos", "x86_64") => Some("_x64.dmg"),
        _ => None,
    }
}

fn pick_asset<'a>(assets: &'a [GitHubAsset], os: &str, arch: &str) -> Option<&'a GitHubAsset> {
    let suffix = asset_suffix_for(os, arch)?;
    assets.iter().find(|asset| asset.name.ends_with(suffix))
}

/// 从列表里挑版本号最高的非草稿 release。
///
/// GitHub 的列表按发布时间倒序，但补发一个旧版本的 hotfix 会让时间序与版本序
/// 不一致，所以按版本号挑而不是取第一个。
fn pick_latest_release(releases: Vec<GitHubRelease>) -> Option<GitHubRelease> {
    releases
        .into_iter()
        .filter(|release| !release.draft)
        .max_by(|left, right| compare_versions(&left.tag_name, &right.tag_name))
}

fn build_update_info(
    current_version: &str,
    release: Option<GitHubRelease>,
    os: &str,
    arch: &str,
) -> UpdateInfo {
    let Some(release) = release else {
        // 一个 release 都没有（或全是草稿）：如实报告「无更新」而不是报错。
        return UpdateInfo {
            current_version: current_version.to_string(),
            latest_version: String::new(),
            has_update: false,
            prerelease: false,
            release_url: RELEASES_PAGE.to_string(),
            notes: String::new(),
            pub_date: String::new(),
            asset_url: String::new(),
            asset_name: String::new(),
            asset_size: 0,
            checked_at: chrono::Utc::now().timestamp_millis(),
        };
    };

    let latest_version = normalize_version(&release.tag_name).to_string();
    let has_update = compare_versions(&latest_version, current_version) == Ordering::Greater;
    let asset = pick_asset(&release.assets, os, arch);

    UpdateInfo {
        current_version: current_version.to_string(),
        latest_version,
        has_update,
        prerelease: release.prerelease,
        release_url: release
            .html_url
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| RELEASES_PAGE.to_string()),
        notes: release.body.unwrap_or_default(),
        pub_date: release.published_at.unwrap_or_default(),
        asset_url: asset
            .map(|asset| asset.browser_download_url.clone())
            .unwrap_or_default(),
        asset_name: asset.map(|asset| asset.name.clone()).unwrap_or_default(),
        asset_size: asset.map(|asset| asset.size).unwrap_or(0),
        checked_at: chrono::Utc::now().timestamp_millis(),
    }
}

/// 查询 GitHub 最新 Release 并与当前版本比较。
///
/// 当前版本取自 `package_info()`，编译期即来自 Cargo.toml，不接受前端传入 ——
/// 前端传参会让「当前版本」变成可被调用方伪造的值。
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let client = reqwest::Client::builder()
        .user_agent(UPDATE_USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("创建更新检查 HTTP 客户端失败: {e}"))?;

    let releases = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("检查更新失败: {e}"))?
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|e| format!("解析发布信息失败: {e}"))?;

    Ok(build_update_info(
        &current_version,
        pick_latest_release(releases),
        std::env::consts::OS,
        std::env::consts::ARCH,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GitHubAsset {
        GitHubAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.test/{name}"),
            size: 1024,
        }
    }

    fn release(tag: &str, assets: Vec<GitHubAsset>) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_string(),
            body: Some("notes".to_string()),
            published_at: Some("2026-09-17T00:00:00Z".to_string()),
            html_url: Some("https://example.test/releases/tag".to_string()),
            draft: false,
            prerelease: false,
            assets,
        }
    }

    #[test]
    fn version_comparison_is_numeric_not_lexicographic() {
        assert_eq!(compare_versions("0.4.9", "0.4.8"), Ordering::Greater);
        assert_eq!(compare_versions("0.4.7", "0.4.8"), Ordering::Less);
        assert_eq!(compare_versions("0.4.8", "0.4.8"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0", "0.9.9"), Ordering::Greater);
        // 字符串比较会把 "0.4.10" 判成小于 "0.4.9"
        assert_eq!(compare_versions("0.4.10", "0.4.9"), Ordering::Greater);
    }

    #[test]
    fn tag_prefixes_and_short_versions_still_parse() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version("  app-v1.2.3 "), "1.2.3");
        assert_eq!(compare_versions("v0.4.8", "0.4.8"), Ordering::Equal);
        assert_eq!(compare_versions("app-v1.2.3", "1.2.2"), Ordering::Greater);
        // 缺失段按 0 计
        assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
    }

    #[test]
    fn a_prerelease_never_outranks_its_final_release() {
        assert_eq!(compare_versions("0.5.0-beta", "0.5.0"), Ordering::Less);
        assert_eq!(compare_versions("0.5.0", "0.5.0-beta"), Ordering::Greater);
        assert_eq!(compare_versions("0.5.0-beta.2", "0.4.8"), Ordering::Greater);
        // build metadata 不影响比较
        assert_eq!(compare_versions("0.5.0+build9", "0.5.0"), Ordering::Equal);
    }

    #[test]
    fn an_unparsable_tag_never_claims_an_update() {
        assert_eq!(compare_versions("nightly", "0.4.8"), Ordering::Less);
        let info = build_update_info("0.4.8", Some(release("nightly", vec![])), "macos", "aarch64");
        assert!(!info.has_update);
    }

    #[test]
    fn asset_pick_follows_the_dmg_naming_from_the_build_scripts() {
        let assets = vec![
            asset("PetGPT_0.5.0_aarch64.dmg"),
            asset("PetGPT_0.5.0_x64.dmg"),
        ];
        assert_eq!(
            pick_asset(&assets, "macos", "aarch64").unwrap().name,
            "PetGPT_0.5.0_aarch64.dmg"
        );
        assert_eq!(
            pick_asset(&assets, "macos", "x86_64").unwrap().name,
            "PetGPT_0.5.0_x64.dmg"
        );
    }

    #[test]
    fn a_missing_or_foreign_asset_falls_back_to_the_release_page() {
        let arm_only = vec![asset("PetGPT_0.5.0_aarch64.dmg")];
        assert!(pick_asset(&arm_only, "macos", "x86_64").is_none());
        assert!(pick_asset(&arm_only, "linux", "x86_64").is_none());

        let info = build_update_info("0.4.8", Some(release("v0.5.0", arm_only)), "linux", "x86_64");
        assert!(info.has_update, "版本更新与平台是否有 DMG 无关");
        assert!(info.asset_url.is_empty());
        assert_eq!(info.asset_size, 0);
        assert!(!info.release_url.is_empty());
    }

    #[test]
    fn the_same_or_older_release_reports_no_update() {
        let assets = vec![asset("PetGPT_0.4.8_aarch64.dmg")];
        let same = build_update_info("0.4.8", Some(release("v0.4.8", assets)), "macos", "aarch64");
        assert!(!same.has_update);
        assert_eq!(same.latest_version, "0.4.8");
        assert_eq!(same.current_version, "0.4.8");

        let older = build_update_info("0.4.8", Some(release("v0.4.7", vec![])), "macos", "aarch64");
        assert!(!older.has_update);
    }

    #[test]
    fn a_draft_release_is_never_offered() {
        let mut draft = release("v9.9.9", vec![asset("PetGPT_9.9.9_aarch64.dmg")]);
        draft.draft = true;
        let info = build_update_info("0.4.8", pick_latest_release(vec![draft]), "macos", "aarch64");
        assert!(!info.has_update);
    }

    #[test]
    fn a_newer_release_exposes_the_matching_download() {
        let assets = vec![
            asset("PetGPT_0.5.0_x64.dmg"),
            asset("PetGPT_0.5.0_aarch64.dmg"),
        ];
        let info = build_update_info("0.4.8", Some(release("v0.5.0", assets)), "macos", "aarch64");
        assert!(info.has_update);
        assert_eq!(info.latest_version, "0.5.0");
        assert_eq!(info.asset_name, "PetGPT_0.5.0_aarch64.dmg");
        assert!(info.asset_url.ends_with("_aarch64.dmg"));
        assert!(info.checked_at > 0);
    }

    #[test]
    fn the_projects_real_tag_shapes_parse_to_the_right_numbers() {
        // 仓库里真实存在的三个 tag
        assert_eq!(normalize_version("PetGPT_0.3.0_alpha_Steins_Gate"), "0.3.0_alpha_Steins_Gate");
        assert_eq!(parse_version("PetGPT_0.3.0_alpha_Steins_Gate").0, [0, 3, 0]);
        assert_eq!(parse_version("PetGPT_0.2.0_alpha_Amadeus").0, [0, 2, 0]);
        assert_eq!(parse_version("Alpha_Release_PetGPT_v0.1.2_alpha").0, [0, 1, 2]);

        // 整段 parse 会把 "2_alpha" 归零、把 0.3.2 误读成 0.3.0
        assert_eq!(parse_version("PetGPT_0.3.2_alpha").0, [0, 3, 2]);
        assert_eq!(compare_versions("PetGPT_0.3.2_alpha", "PetGPT_0.3.0_alpha"), Ordering::Greater);

        // 名字里的数字不能被当成版本号
        assert_eq!(parse_version("PetGPT2_v1.4.0").0, [1, 4, 0]);
    }

    #[test]
    fn the_existing_alpha_releases_do_not_look_newer_than_the_shipped_version() {
        let releases = vec![
            release("PetGPT_0.3.0_alpha_Steins_Gate", vec![asset("petgpt-0.3.0-MacOS.dmg")]),
            release("PetGPT_0.2.0_alpha_Amadeus", vec![]),
            release("Alpha_Release_PetGPT_v0.1.2_alpha", vec![]),
        ];
        let info = build_update_info("0.4.8", pick_latest_release(releases), "macos", "aarch64");
        assert!(!info.has_update, "0.3.0-alpha 不应该盖过已装的 0.4.8");
        assert_eq!(info.latest_version, "0.3.0_alpha_Steins_Gate");
        // 历史资产用的是旧命名，匹配不上，前端退回 Release 页
        assert!(info.asset_url.is_empty());
    }

    #[test]
    fn the_newest_release_wins_even_when_published_out_of_order() {
        // 先发 0.6.0，之后补发 0.5.1 的 hotfix —— 列表顺序不能决定结果
        let releases = vec![
            release("v0.5.1", vec![]),
            release("v0.6.0", vec![asset("PetGPT_0.6.0_aarch64.dmg")]),
        ];
        let picked = pick_latest_release(releases).expect("a release");
        assert_eq!(picked.tag_name, "v0.6.0");
    }

    #[test]
    fn a_prerelease_channel_still_reports_updates_but_is_labelled() {
        // 本项目至今只发 prerelease，过滤掉它们等于让整个功能失效
        let mut pre = release("v0.5.0", vec![asset("PetGPT_0.5.0_aarch64.dmg")]);
        pre.prerelease = true;
        let info = build_update_info("0.4.8", pick_latest_release(vec![pre]), "macos", "aarch64");
        assert!(info.has_update);
        assert!(info.prerelease, "界面需要据此标注「预发布版」");
    }

    #[test]
    fn a_repo_with_no_usable_release_reports_no_update_instead_of_failing() {
        let info = build_update_info("0.4.8", pick_latest_release(vec![]), "macos", "aarch64");
        assert!(!info.has_update);
        assert!(info.latest_version.is_empty());
        assert!(info.release_url.contains("releases"));

        let mut draft = release("v9.9.9", vec![]);
        draft.draft = true;
        assert!(pick_latest_release(vec![draft]).is_none());
    }

}
