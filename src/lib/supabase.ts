import { createClient } from '@supabase/supabase-js';

// Public by design: the publishable key is safe in the browser; row-level security protects the data.
export const supabase = createClient(
  'https://wgoiukbgrdyjvfpqaipp.supabase.co',
  'sb_publishable_B4fokBi_LoR1Pe8o39kTQA_REnB2KbK'
);
