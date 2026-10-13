# Genex's stills of a Godot scene: plays the scene for a few frames, then saves what each camera in
# the `genex_shot` group sees (else what the scene's own camera sees) as a PNG. Run windowed, as
# `godot --path <project> -s genex_capture.gd -- <scene or ""> <out prefix> <frames> <max shots>`.
# It writes only the PNGs named by the prefix and prints one `GENEX_SHOT <name> <file>` line each.
extends SceneTree

const SHOT_GROUP := "genex_shot"
const SHOT_LINE := "GENEX_SHOT %s %s"
const NO_SCENE := "GENEX_NO_SCENE %s"
const DEFAULT_FRAMES := 30
const DEFAULT_SHOTS := 4


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var scene_path := _arg(args, 0, "")
	if scene_path == "":
		scene_path = String(ProjectSettings.get_setting("application/run/main_scene", ""))
	var prefix := _arg(args, 1, "")
	var frames := int(_arg(args, 2, str(DEFAULT_FRAMES)))
	var most := int(_arg(args, 3, str(DEFAULT_SHOTS)))
	var packed := load(scene_path) as PackedScene
	if packed == null or prefix == "":
		print(NO_SCENE % scene_path)
		quit(1)
		return
	var scene := packed.instantiate()
	root.add_child(scene)
	current_scene = scene
	for i in max(frames, 1):
		await process_frame
	await _shoot(prefix, most)
	quit(0)


func _shoot(prefix: String, most: int) -> void:
	var cameras := get_nodes_in_group(SHOT_GROUP).filter(func(node): return node is Camera3D or node is Camera2D)
	if cameras.is_empty():
		await _save("main", prefix, 0)
		return
	for index in min(cameras.size(), most):
		var camera = cameras[index]
		camera.make_current()
		await _save(String(camera.name), prefix, index)


func _save(name: String, prefix: String, index: int) -> void:
	await RenderingServer.frame_post_draw
	var file := "%s-%d.png" % [prefix, index]
	if root.get_texture().get_image().save_png(file) == OK:
		print(SHOT_LINE % [name.replace(" ", "_"), file])


func _arg(args: PackedStringArray, index: int, fallback: String) -> String:
	return String(args[index]) if args.size() > index else fallback
