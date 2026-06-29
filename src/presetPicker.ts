import { openPresetPickerWebview } from './presetPickerWebview';

export async function pickFilesForCustomPreset(filePaths: string[]): Promise<string[] | undefined> {
    return openPresetPickerWebview(filePaths);
}
