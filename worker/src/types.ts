export type VideoJobStatus =
  | "pending"
  | "generating_script"
  | "generating_audio"
  | "recording_profile"
  | "rendering_video"
  | "uploading_to_loom"
  | "done"
  | "failed";

export type VideoJob = {
  id: string;
  lead_id: string;
  status: VideoJobStatus;
  hook_script: string | null;
  audio_path: string | null;
  screen_recording_path: string | null;
  rendered_video_path: string | null;
  rendered_video_storage_url: string | null;
  loom_url: string | null;
  loom_embed_code: string | null;
  error_message: string | null;
  attempt_count: number;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
};

// Minimal slice of `leads` the video pipeline actually needs.
export type VideoLead = {
  id: string;
  username: string;
  full_name: string | null;
  profile_url: string;
  external_link: string | null;
  funnel_url: string | null;
  funnel_program_name: string | null;
  niche: string | null;
  business_model: string | null;
  offer_type: string | null;
};
