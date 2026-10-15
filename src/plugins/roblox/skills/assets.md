# Assets that pass Roblox's rules

Models, textures and sounds made for this game (in Blender, by Genex's or Roblox's generators) end
up uploaded to the person's Roblox account. Roblox moderates every upload, and a refused upload, or
one its moderation judges against the rules, counts against **the person's account**: warnings, and
in the worst case a ban. So every upload and every Roblox AI tool asks the person first, in the
chat, and an asset is checked before it is offered.

## Meshes

- At most **20,000 triangles** per mesh. Aim far lower for props a phone draws many times: a few
  hundred to a few thousand.
- **Watertight**: every edge shared by exactly two faces, no holes, no stray faces, non-zero
  volume. No n-gons (triangles and quads only, triangulated on export).
- **One material per mesh.** A model that needs several materials is several meshes, each its own
  MeshPart with its own `SurfaceAppearance`.
- **Rigs**: at most 4 bone influences per vertex, bones frozen (no scale), the root at 0, 0, 0, and
  one animation per `.fbx`.
- The model's origin sits where it should stand or pivot, at real scale (1 stud is about 28 cm;
  a door is about 7 studs tall).
- Formats: `.fbx`, `.gltf`/`.glb` or `.obj`. Prefer `.glb`: it carries the hierarchy and the PBR
  textures in one file.

## Textures

- Phone-sized by default: **1024 by 1024 at most**, square powers of two (256, 512, 1024). Larger only
  for a hero object, and only when the person asks.
- PBR goes in a `SurfaceAppearance`: colour, normal, roughness, metalness, and emissive where needed.
  A `SurfaceAppearance` can't be changed while the game runs; swap the part to change it.
- No text, logos, brands, real people's faces or anything that looks like them in a texture. Keep
  generated textures plain: these are what automated moderation flags.

## In the place

- `CollisionFidelity`: `Box` or `Hull` for decoration and anything a player can't stand on;
  `PreciseConvexDecomposition` only where precise contact matters. Small decoration gets
  `CanCollide`, `CanTouch` and `CanQuery` off.
- `RenderFidelity = Automatic` so far-away meshes draw cheaply.
- Reuse one mesh many times instead of many near-copies; group repeats in a Model.
- Keep the place light for phones: turn on `Workspace.StreamingEnabled` for large worlds, and avoid
  thousands of unanchored parts.

## Audio

- Sound files are at most 20 MB and 7 minutes. Each account has a monthly upload allowance (larger
  when the account is ID-verified), so upload sound only when it is needed.
- Use Roblox's own free sound library (through `search_asset`) before uploading anything.

## Roblox's AI tools and uploads

- Roblox's generators are the plugin's tools: `roblox__generate-mesh` (a textured mesh),
  `roblox__generate-model` (a model of simple parts with attributes; about 50 a day),
  `roblox__generate-texture`, `roblox__generate-material` and `roblox__segment-mesh`. Each shows
  the person a card first. Use them only for what the person asked for, and keep prompts plain.
- Long generations: pass `background: true`, then wait with the connection's `wait_job_finished`.
- `roblox__store-image` turns a picture in the game folder into an `IMAGEID_…` for
  `generate-model`'s `image`. `roblox__upload-image` uploads pictures (game-folder files or https
  addresses) as image assets and answers each one's `rbxassetid`.
- Lists (part names, pictures) are one string: `head, body, tail` or `["head", "body", "tail"]`.
- When the person declines a card, don't ask again for the same thing in that turn.

## Inserting from the Creator Store

- Find the asset with the connection's `search_asset`, then insert it with `roblox__insert-asset`
  (its id, name and type from the search). Genex refuses paid assets, and the person approves each
  insert on a card.
- A model from the store can carry scripts. The insert's answer lists every script it brought;
  read each one; delete any you don't understand, and every one flagged for `require` with a
  number, `loadstring`, `getfenv`, `HttpService` or `MarketplaceService`: those are how backdoors
  hide.
- Credit the creator where the person wants credits shown.

## Ownership

- An asset uploaded by the person can be used in their own games. Animations are tied to the
  account or group that owns the game; moving a game to a group means uploading its animations
  again.
- Never reference asset ids the person doesn't own or that aren't free to use; they fail to load in
  the live game or break the rules.
