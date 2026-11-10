package routes

// phiAllowed lists the PHI functions the dashboard may call through the bridge
// (POST /api/tv/phi). Anything else is refused with 400. "launch" is not a PHI
// function: the hook starts the given launcher item with its own launch code.
// Never add Factory*, Wifi passwords, ESN, Calman or anything else that
// returns or sets a secret.
var phiAllowed = map[string]bool{
	// picture
	"RpcPictureConfigRetrieve":       true,
	"RpcPictureGroupPictureRootGet":  true,
	"RpcPictureGroupContrastGet":     true,
	"RpcPictureGroupColorGet":        true,
	"RpcPictureGroupSharpnessGet":    true,
	"RpcPictureGroupMotionGet":       true,
	"RpcPictureGroupPictureCleanGet": true,
	"RpcPictureFormatGet":            true,
	"RpcPictureFormatAllowedGet":     true,
	"RpcPictureHDRStatusGet":         true,
	"RpcPictureFramerateGet":         true,
	// sound
	"RpcGetTvSoundStyle":     true,
	"RpcAudioEffectsGet":     true,
	"RpcAudioSpeechGet":      true,
	"RpcAudioDescriptionGet": true,
	"RpcMixedVolumeGet":      true,
	// general
	"RpcGeneralSwitchOffTimerGet":        true,
	"RpcGeneralNoSignalTimerGet":         true,
	"RpcGeneralHDMIUltraHDGet":           true,
	"RpcGeneralAutoHDMIUltraHDGet":       true,
	"RpcGeneralEasyLinkRemoteControlGet": true,
	"RpcGeneralAutoMovieModeGet":         true,
	"RpcModelInfoGet":                    true,
	"RpcNetworkTVNameGet":                true,
	// settings the dashboard changes (params from PHI's own settings pages,
	// see docs/dashboard/)
	"RpcGeneralSrttingConfigRetrieve":    true, // sic, PHI's spelling
	"RpcGeneralSwitchOffTimerSet":        true,
	"RpcGeneralEasyLinkRemoteControlSet": true,
	"RpcPictureStyleSet":                 true,
	"RpcPictureBrightnessSet":            true,
	"RpcPictureColourSet":                true,
	"RpcPictureConstrastSet":             true, // sic
	"RpcPictureSharpnessSet":             true,
	"RpcPictureLightSensorSet":           true,
	"RpcSoundRetrieve":                   true,
	"RpcSoundStyleSet":                   true,
	"RpcSoundAiequalzerSet":              true, // sic
	"RpcSoundClearDialogueSet":           true,
	"RpcSoundDolbyAtmosSet":              true,
	"RpcGameBarProfileConfigGet":         true,
	"RpcGameBarProfileConfigSet":         true,
	"RpcSetupAmbilightGetConfig":         true,
	"RpcSetupAmbilightStyleSet":          true,
	"RpcAmbilightBrightnessSet":          true,
	"RpcScreenOff":                       true,
	// actions
	"RpcRestartTV": true,
	"launch":       true,
	"sources":      true, // the inputs, as the launcher lists them
	"source":       true, // switch to {typeId}
}
