use device_query::{DeviceQuery, DeviceState, MouseState};
use serde_json::json;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use windows_capture::encoder::VideoSettingsSubType;

use serde::{Deserialize, Serialize};
use serde_json;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use windows_capture::window::Window;

use windows::{
    Win32::Foundation::{BOOL, HWND, LPARAM, RECT},
    Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, GetWindowTextW, IsWindowVisible},
};

use std::ffi::c_void;
use windows_capture::monitor::Monitor;
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
};
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct RectInfo {
    pub left: i32,
    pub right: i32,
    pub top: i32,
    pub bottom: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct WindowInfo {
    pub hwnd: usize,
    pub title: String,
    pub rect: RectInfo,
}

#[derive(Clone)]
pub struct MouseTrackingState {
    pub mouse_positions: Arc<Mutex<Vec<serde_json::Value>>>,
    pub start_time: SystemTime,
    pub is_tracking: Arc<AtomicBool>,
    pub is_recording: Arc<AtomicBool>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy)]
pub struct MousePosition {
    pub x: f32,
    pub y: f32,
    pub timestamp: u128,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct SourceData {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f32,
}

pub struct StCapture {
    pub state: MouseTrackingState,
    pub capture_dir: PathBuf,
    pub video_completion_callback: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
}

impl StCapture {
    pub fn new(capture_dir: PathBuf) -> StCapture {
        let state = MouseTrackingState {
            mouse_positions: Arc::new(Mutex::new(Vec::new())),
            start_time: SystemTime::now(),
            is_tracking: Arc::new(AtomicBool::new(false)),
            is_recording: Arc::new(AtomicBool::new(false)),
        };

        return Self { 
            state, 
            capture_dir, 
            video_completion_callback: None 
        };
    }

    pub fn set_video_completion_callback<F>(&mut self, callback: F) 
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        self.video_completion_callback = Some(Arc::new(callback));
    }

    pub fn save_source_data(
        &self,
        hwnd: usize,
        current_project_id: String,
    ) -> Result<serde_json::Value, String> {
        let window_info =
            get_window_info_by_usize(hwnd).expect("Couldn't get window info by usize");

        let source_data = json!({
            "id": hwnd.to_string(),
            "name": window_info.title,
            "width": window_info.rect.width,
            "height": window_info.rect.height,
            "x": window_info.rect.left,
            "y": window_info.rect.top,
            "scale_factor": 1.0
        });

        // let save_path = app_handle.path_resolver().app_data_dir().unwrap();
        let file_path = self
            .capture_dir
            .join("projects")
            .join(&current_project_id)
            .join("sourceData.json");

        fs::write(
            file_path,
            serde_json::to_string_pretty(&source_data).unwrap(),
        )
        .map_err(|e| e.to_string())?;

        Ok(source_data)
    }

    // Only called once at beginning of tracking
    pub fn start_mouse_tracking(&mut self) -> Result<bool, String> {
        // self.state.mouse_positions = Arc::new(Mutex::new(Vec::new()));
        self.state.start_time = SystemTime::now();
        self.state.is_tracking.store(true, Ordering::SeqCst);

        let mouse_positions = self.state.mouse_positions.clone();
        let start_time = self.state.start_time;
        let is_tracking = self.state.is_tracking.clone();

        thread::spawn(move || {
            let device_state = DeviceState::new();
            while is_tracking.load(Ordering::SeqCst) {
                let mouse: MouseState = device_state.get_mouse();
                let now = SystemTime::now();
                let timestamp = now.duration_since(start_time).unwrap().as_millis();

                if let Ok(existing_positions) = &mut mouse_positions.try_lock() {
                    // println!(
                    //     "Tracking mouse {:?} {:?} {:?}",
                    //     mouse.coords,
                    //     existing_positions.len(),
                    //     timestamp
                    // );

                    let position = json!({
                        "x": mouse.coords.0,
                        "y": mouse.coords.1,
                        "timestamp": timestamp
                    });

                    existing_positions.push(position);
                    thread::sleep(Duration::from_millis(100));
                } else {
                    println!("Can't acquire lock in stop_mouse_tracking");
                }
            }
        });

        Ok(true)
    }

    pub fn stop_mouse_tracking(&mut self, project_id: String) -> Result<String, String> {
        // Signal the tracking thread to stop
        self.state.is_tracking.store(false, Ordering::SeqCst);

        let mouse_positions = self.state.mouse_positions.lock().unwrap().clone();

        println!("Saving mouse positions {:?}", mouse_positions.len());

        let file_path = self
            .capture_dir
            .join("projects")
            .join(&project_id)
            .join("mousePositions.json");

        fs::write(
            file_path.clone(),
            serde_json::to_string_pretty(&mouse_positions).unwrap(),
        )
        .map_err(|e| e.to_string())?;

        // reset mouse positions
        self.state.mouse_positions = Arc::new(Mutex::new(Vec::new()));

        Ok(file_path
            .to_str()
            .expect("Couldn't create string from path")
            .to_string())
    }

    pub fn get_project_data(
        &self,
        current_project_id: String,
    ) -> Result<serde_json::Value, String> {
        // let save_path = app_handle.path_resolver().app_data_dir().unwrap();
        let project_path = self.capture_dir.join("projects").join(&current_project_id);

        let mouse_positions: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(project_path.join("mousePositions.json"))
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        let source_data: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(project_path.join("sourceData.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        // let original_capture =
        //     fs::read(project_path.join("capture.mp4")).map_err(|e| e.to_string())?;

        Ok(json!({
            "currentProjectId": current_project_id,
            "mousePositions": mouse_positions,
            // "originalCapture": original_capture,
            "sourceData": source_data,
        }))
    }

    pub fn start_video_capture(
        &mut self,
        hwnd: usize,
        width: u32,
        height: u32,
        project_id: String,
    ) -> Result<(), String> {
        let is_recording = self.state.is_recording.load(Ordering::SeqCst);

        if is_recording {
            return Err("Already recording".to_string());
        }

        // *is_recording = true;
        self.state.is_recording.store(true, Ordering::SeqCst);

        println!("Start capture...");

        let retain_hwnd = hwnd.clone();

        let hwnd = HWND(hwnd as *mut _);
        let raw_hwnd = hwnd.0 as *mut c_void;
        let target_window: Window = unsafe { Window::from_raw_hwnd(raw_hwnd) };

        let project_path = self.capture_dir.join("projects").join(&project_id);

        fs::create_dir_all(&project_path)
            .ok()
            .expect("Couldn't check or create Stunts Projects directory");

        self.save_source_data(retain_hwnd, project_id.clone())
            .expect("Couldn't save source data");

        let output_path = project_path
            .join("capture_pre.mp4")
            .to_str()
            .unwrap()
            .to_string();
        let compressed_path = project_path
            .join("capture.mp4")
            .to_str()
            .unwrap()
            .to_string();

        // Clone the callback Arc for use in the capture settings
        let callback_clone = self.video_completion_callback.clone();

        // hardcode hd for testing to avoid miscolored recording,
        // TBD: scale to fullscreen width / height for users
        if width > 1920 || height > 1080 {
            let primary_monitor = Monitor::primary().expect("There is no primary monitor");

            // windows-capture 1.4.2?
            // let settings = Settings::new(
            //     primary_monitor,
            //     CursorCaptureSettings::Default,
            //     DrawBorderSettings::Default,
            //     ColorFormat::Rgba8,
            //     (
            //         output_path,
            //         compressed_path,
            //         1920,
            //         1080,
            //         self.state.is_recording.clone(),
            //     ),
            // );

            // 1.5?
            let settings = Settings::new(
                // Item to capture
                primary_monitor,
                // Capture cursor settings
                CursorCaptureSettings::Default,
                // Draw border settings
                DrawBorderSettings::Default,
                // Secondary window settings, if you want to include secondary windows in the capture
                SecondaryWindowSettings::Default,
                // Minimum update interval, if you want to change the frame rate limit (default is 60 FPS or 16.67 ms)
                MinimumUpdateIntervalSettings::Default,
                // Dirty region settings,
                DirtyRegionSettings::Default,
                // The desired color format for the captured frame.
                ColorFormat::Rgba8,
                // Additional flags for the capture settings that will be passed to the user-defined `new` function.
                (
                    output_path,
                    compressed_path,
                    1920,
                    1080,
                    self.state.is_recording.clone(),
                    callback_clone,
                ),
            );

            if let Err(e) = Capture::start_free_threaded(settings) {
                eprintln!("Capture error: {}", e);
                // Ensure is_recording is set to false if an error occurs
                self.state.is_recording.store(false, Ordering::SeqCst);
            }
        } else {
            // Create another callback clone for the else branch
            let callback_clone2 = self.video_completion_callback.clone();

            let settings = Settings::new(
                // Item to capture
                target_window,
                // Capture cursor settings
                CursorCaptureSettings::Default,
                // Draw border settings
                DrawBorderSettings::Default,
                // Secondary window settings, if you want to include secondary windows in the capture
                SecondaryWindowSettings::Default,
                // Minimum update interval, if you want to change the frame rate limit (default is 60 FPS or 16.67 ms)
                MinimumUpdateIntervalSettings::Default,
                // Dirty region settings,
                DirtyRegionSettings::Default,
                // The desired color format for the captured frame.
                ColorFormat::Rgba8,
                // Additional flags for the capture settings that will be passed to the user-defined `new` function.
                (
                    output_path,
                    compressed_path,
                    width,
                    height,
                    self.state.is_recording.clone(),
                    callback_clone2,
                ),
            );
        
            if let Err(e) = Capture::start_free_threaded(settings) {
                eprintln!("Capture error: {}", e);
                // Ensure is_recording is set to false if an error occurs
                self.state.is_recording.store(false, Ordering::SeqCst);
            }
        }

        Ok(())
    }

    pub fn stop_video_capture(&mut self, project_id: String) -> Result<(String, String), String> {
        let project_path = self.capture_dir.join("projects").join(&project_id);
        let output_path = project_path
            .join("capture_pre.mp4")
            .to_str()
            .unwrap()
            .to_string();
        let source_data_path = project_path
            .join("sourceData.json")
            .to_str()
            .unwrap()
            .to_string();

        // let state = app_handle.state::<MouseTrackingState>();
        // let mut is_recording = self.state.is_recording.lock().unwrap();
        let is_recording = self.state.is_recording.load(Ordering::SeqCst);

        println!("Check if recording... {:?}", is_recording);

        if !is_recording {
            return Err("Not currently recording".to_string());
        }

        // *is_recording = false;
        self.state.is_recording.store(false, Ordering::SeqCst);

        println!("recording finished!");

        // give time for video to save out
        // thread::sleep(Duration::from_millis(500));

        Ok((output_path, source_data_path))
    }
}

pub fn get_sources() -> Result<Vec<WindowInfo>, String> {
    // use windows::Win32::Foundation::BOOLEAN;

    let mut windows: Vec<WindowInfo> = Vec::new();

    // EnumWindows callback to enumerate all top-level windows
    unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // Only capture windows that are visible
        if IsWindowVisible(hwnd).as_bool() {
            // Get the window title and its rect (position/size)
            if let Ok((title, rect)) = get_window_info(hwnd) {
                let sources = lparam.0 as *mut Vec<WindowInfo>;
                let window_info = WindowInfo {
                    hwnd: hwnd.0 as usize,
                    title: title,
                    rect: RectInfo {
                        left: rect.left,
                        top: rect.top,
                        right: rect.right,
                        bottom: rect.bottom,
                        width: rect.right - rect.left,
                        height: rect.bottom - rect.top,
                    },
                };
                (*sources).push(window_info);
            }
        }

        // 1 // Continue enumeration
        true.into() // Continue enumeration
    }

    unsafe {
        // Enumerate all top-level windows
        EnumWindows(
            Some(enum_windows_callback),
            LPARAM(&mut windows as *mut _ as isize),
        )
        .expect("Couldn't enumerate windows");
    }

    Ok(windows)
}

pub fn get_window_info(hwnd: HWND) -> Result<(String, RECT), String> {
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).expect("Couldn't get WindowRect");

        let mut title: [u16; 512] = [0; 512];
        let len = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..len as usize]);
        Ok((title, rect))
    }
}

pub fn get_window_info_by_usize(hwnd_value: usize) -> Result<WindowInfo, String> {
    // Convert the usize back into an HWND
    let hwnd = HWND(hwnd_value as *mut _);

    if let Ok((title, rect)) = get_window_info(hwnd) {
        let window_info = WindowInfo {
            hwnd: hwnd_value,
            title: title,
            rect: RectInfo {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            },
        };
        Ok(window_info)
    } else {
        Err("Failed to get window information".to_string())
    }
}

struct Capture {
    encoder: Option<VideoEncoder>,
    is_recording: Arc<AtomicBool>,
    output_path: String,
    compressed_path: String,
    completion_callback: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = (String, String, u32, u32, Arc<AtomicBool>, Option<Arc<dyn Fn(String) + Send + Sync + 'static>>);
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (output_path, compressed_path, width, height, is_recording, completion_callback) = ctx.flags;
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(width, height).sub_type(VideoSettingsSubType::H264),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &output_path,
        )?;

        Ok(Self {
            encoder: Some(encoder),
            is_recording,
            output_path,
            compressed_path,
            completion_callback,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if let Some(encoder) = &mut self.encoder {
            encoder.send_frame(frame)?;
        }

        let is_recording = self.is_recording.load(Ordering::SeqCst);

        if !is_recording {
            println!("No longer recording...");
            if let Some(encoder) = self.encoder.take() {
                println!("Encoder finish...");
                encoder.finish()?;
                
                // Call the completion callback if it exists
                if let Some(ref callback) = self.completion_callback {
                    callback(self.output_path.clone());
                }
            }
            capture_control.stop();
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture Session Closed");
        Ok(())
    }
}
