import { openPresetPickerWebview, PresetSelection } from './presetPickerWebview';

export async function pickFilesForCustomPreset(filePaths: string[]): Promise<PresetSelection | undefined> {
    return openPresetPickerWebview(filePaths);
}
