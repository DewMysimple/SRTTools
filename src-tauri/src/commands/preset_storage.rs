//! Fixed preset keys only: coherent snapshots and one atomic CAS commit for mixed imports.
use super::{
    commit_local_values, ensure_main, folder_import, local_values, Map, Value, PRESET_KEY,
    PRESET_LIMIT, STORE_TRANSACTION, WORKFLOW_KEY, WORKFLOW_LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{io::Read, path::Path};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const IMPORT_LIMIT: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PresetValues {
    tools: Option<Value>,
    workflows: Option<Value>,
}

impl PresetValues {
    fn from_values(values: &Map<String, Value>) -> Self {
        Self {
            tools: values
                .get(PRESET_KEY)
                .filter(|value| !value.is_null())
                .cloned(),
            workflows: values
                .get(WORKFLOW_KEY)
                .filter(|value| !value.is_null())
                .cloned(),
        }
    }

    fn validate(&self) -> Result<(), String> {
        for (value, limit) in [
            (&self.tools, PRESET_LIMIT),
            (&self.workflows, WORKFLOW_LIMIT),
        ] {
            if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > limit {
                return Err("预设事务超过工具 256 KiB 或流程 512 KiB 限制，原数据未修改。".into());
            }
        }
        Ok(())
    }

    fn apply(self, values: &mut Map<String, Value>) {
        for (key, value) in [(PRESET_KEY, self.tools), (WORKFLOW_KEY, self.workflows)] {
            if let Some(value) = value {
                values.insert(key.to_owned(), value);
            } else {
                values.remove(key);
            }
        }
    }
}

fn stage_preset_values(
    values: &Map<String, Value>,
    expected: &PresetValues,
    next: PresetValues,
) -> Result<Map<String, Value>, String> {
    next.validate()?;
    if &PresetValues::from_values(values) != expected {
        return Err("预设在预览后已改变，请重新预览导入。".into());
    }
    let mut staged = values.clone();
    next.apply(&mut staged);
    Ok(staged)
}

#[tauri::command]
pub fn get_preset_values(app: AppHandle, window: WebviewWindow) -> Result<PresetValues, String> {
    ensure_main(&window)?;
    let _transaction = STORE_TRANSACTION
        .lock()
        .map_err(|_| "预设事务正在恢复，请重启应用。")?;
    let (values, _) = local_values(&app)?;
    Ok(PresetValues::from_values(&values))
}

#[tauri::command]
pub fn set_preset_values(
    app: AppHandle,
    window: WebviewWindow,
    expected: PresetValues,
    next: PresetValues,
) -> Result<(), String> {
    ensure_main(&window)?;
    let _transaction = STORE_TRANSACTION
        .lock()
        .map_err(|_| "预设事务正在恢复，请重启应用。")?;
    let (previous, path) = local_values(&app)?;
    let values = stage_preset_values(&previous, &expected, next)?;
    commit_local_values(&path, &previous, &values)
}

fn read_selected_preset(path: &Path) -> Result<Vec<u8>, String> {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return Err("请选择 JSON 预设文件；此入口不导入字幕。".into());
    }
    let entry = folder_import::locked_open(path, None, false)
        .map_err(|_| "无法安全读取所选预设；不接受链接、目录或被占用的文件。")?;
    if entry.metadata.len() > IMPORT_LIMIT {
        return Err("预设 JSON 最多 1 MiB，请分批导入。".into());
    }
    let mut bytes = Vec::new();
    entry
        .file
        .take(IMPORT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取预设失败：{e}"))?;
    if bytes.len() as u64 > IMPORT_LIMIT {
        return Err("读取时预设 JSON 超过 1 MiB，原存储未修改。".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn read_preset_import_file(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<Vec<u8>>, String> {
    ensure_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("导入 SRTTools 预设 JSON")
            .add_filter("SRTTools 预设 JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|e| format!("无法识别预设文件路径：{e}"))?;
        read_selected_preset(&path).map(Some)
    })
    .await
    .map_err(|e| format!("预设文件选择未能完成：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preset_transaction_changes_only_two_fixed_keys_and_enforces_separate_limits() {
        let mut values: Map<String, Value> = serde_json::from_value(json!({
            "settings": {"theme":"dark"}, "history":[{"id":"keep"}],
            "tool-presets-v1":{"schemaVersion":1,"presets":[]}
        }))
        .unwrap();
        let previous = values.clone();
        let snapshot = PresetValues::from_values(&values);
        let next = PresetValues {
            tools: Some(json!({"schemaVersion":1,"presets":[{"name":"tool"}]})),
            workflows: Some(json!({"schemaVersion":1,"presets":[{"name":"flow"}]})),
        };
        next.validate().unwrap();
        values = stage_preset_values(&values, &snapshot, next.clone()).unwrap();
        assert_eq!(values["settings"], previous["settings"]);
        assert_eq!(values["history"], previous["history"]);
        assert_ne!(PresetValues::from_values(&values), snapshot);
        assert_eq!(PresetValues::from_values(&values), next);
        assert!(stage_preset_values(&values, &snapshot, next.clone())
            .unwrap_err()
            .contains("预览后已改变"));
        let too_large = PresetValues {
            tools: Some(json!("x".repeat(PRESET_LIMIT))),
            workflows: None,
        };
        assert!(too_large.validate().is_err());
        let too_large = PresetValues {
            tools: None,
            workflows: Some(json!("x".repeat(WORKFLOW_LIMIT))),
        };
        assert!(too_large.validate().is_err());
        assert!(serde_json::from_value::<PresetValues>(
            json!({"tools":null,"workflows":null,"settings":{}})
        )
        .is_err());
        let explicit_null = serde_json::from_value(json!({"tool-presets-v1":null})).unwrap();
        let round_trip: PresetValues = serde_json::from_value(
            serde_json::to_value(PresetValues::from_values(&explicit_null)).unwrap(),
        )
        .unwrap();
        assert!(stage_preset_values(&explicit_null, &round_trip, round_trip.clone()).is_ok());
    }

    #[test]
    #[cfg(windows)]
    fn mixed_preset_publication_failure_preserves_the_entire_previous_file() {
        use std::{
            fs,
            os::windows::fs::OpenOptionsExt,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "srttools-preset-atomic-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("subtitle-tools.json");
        let original = b"{\n \"settings\":{\"theme\":\"dark\"},\n \"history\":[],\n \"tool-presets-v1\":{\"schemaVersion\":1,\"presets\":[]}\n}";
        fs::write(&path, original).unwrap();
        let previous: Map<String, Value> = serde_json::from_slice(original).unwrap();
        let expected = PresetValues::from_values(&previous);
        let next = PresetValues {
            tools: Some(json!({"schemaVersion":1,"presets":[{"name":"new tool"}]})),
            workflows: Some(json!({"schemaVersion":1,"presets":[{"name":"new flow"}]})),
        };
        let staged = stage_preset_values(&previous, &expected, next.clone()).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(commit_local_values(&path, &previous, &staged).is_err());
        drop(lock);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        commit_local_values(&path, &previous, &staged).unwrap();
        let committed: Map<String, Value> =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(PresetValues::from_values(&committed), next);
        assert_eq!(committed["settings"], previous["settings"]);
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn json_picker_read_is_bounded_and_rejects_links_without_any_path_ipc() {
        use std::{
            fs,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "srttools-preset-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("预设.JSON");
        fs::write(&path, b"{\"format\":\"srttools-presets\"}").unwrap();
        assert_eq!(
            read_selected_preset(&path).unwrap(),
            fs::read(&path).unwrap()
        );
        let oversized = root.join("large.json");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(IMPORT_LIMIT + 1)
            .unwrap();
        assert!(read_selected_preset(&oversized)
            .unwrap_err()
            .contains("1 MiB"));
        assert!(read_selected_preset(&root.join("source.srt")).is_err());
        if std::os::windows::fs::symlink_file(&path, root.join("link.json")).is_ok() {
            assert!(read_selected_preset(&root.join("link.json")).is_err());
            fs::remove_file(root.join("link.json")).unwrap();
        }
        fs::remove_file(path).unwrap();
        fs::remove_file(oversized).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
