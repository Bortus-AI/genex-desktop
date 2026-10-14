/**
 * Settings → Genex account: the account's avatar, Generated (made from its id, every account has
 * one, and Regenerate gives it another) or Photo (one it uploaded), and its name. Each applies
 * everywhere at once, in the app and on genex.games; there is no "use it there too". Shown while
 * Genex is signed in.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { avatarRecipe } from "../../shared/avatar-recipe.ts";
import { AvatarStyle, PLAY_NAME_LENGTH, type PlayMe, playName } from "../../shared/play-people.ts";
import { AvatarMotion, GeneratedAvatar } from "../avatars/GeneratedAvatar.tsx";
import { GenexTab, openGenexPage } from "./plugins/genex/genex-tab.ts";
import { avatarWebp } from "../play/avatar-image.ts";
import { useRegenerateAvatar } from "../play/use-regenerate-avatar.ts";
import { usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { ACCOUNT_WORDS, PLAY_WORDS } from "../words.ts";

const WORDS = ACCOUNT_WORDS;
/** The two choices' pictures. */
const CHOICE_AVATAR = 72;

/** The style the account shows: the one it chose, else the generated one. */
const shownStyle = (me: PlayMe): AvatarStyle => me.avatarStyle ?? AvatarStyle.Generated;

/** One of the two choices: its picture over its name. */
function Choice({
  style,
  me,
  disabled,
  onChoose,
}: {
  style: AvatarStyle;
  me: PlayMe;
  disabled: boolean;
  onChoose: (style: AvatarStyle) => void;
}): JSX.Element {
  const recipe = useMemo(() => avatarRecipe(me.id, me.avatarVariant), [me.id, me.avatarVariant]);
  const on = shownStyle(me) === style;
  const generated = style === AvatarStyle.Generated;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className="account-choice"
      data-avatar-choice={style}
      data-avatar-host
      disabled={disabled}
      onClick={() => onChoose(style)}
    >
      {generated && <GeneratedAvatar recipe={recipe} size={CHOICE_AVATAR} full motion={AvatarMotion.Live} />}
      {!generated && me.photoUrl && (
        <span className="person-avatar" style={{ width: CHOICE_AVATAR, height: CHOICE_AVATAR }}>
          <img src={me.photoUrl} alt="" draggable={false} />
        </span>
      )}
      {!generated && !me.photoUrl && (
        <span className="account-choice-empty" aria-hidden="true">
          <Icon name="camera" size={22} />
        </span>
      )}
      {generated ? WORDS.generated : WORDS.photo}
    </button>
  );
}

/** What the upload button says: busy, replacing a photo, or uploading the first. */
function uploadWords(busy: boolean, hasPhoto: boolean): string {
  if (busy) return WORDS.uploading;
  return hasPhoto ? WORDS.replacePhoto : WORDS.uploadPhoto;
}

/** What picking a photo needs: the hidden file field, the press that opens it, and whether it is uploading. */
interface PhotoUpload {
  field: JSX.Element;
  pick(): void;
  busy: boolean;
}

/** The file field behind Upload and an empty Photo: a picked picture becomes the account's photo, shown everywhere. */
function usePhotoUpload(): PhotoUpload {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const picked = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      await studio().people.setAvatar(await avatarWebp(file));
    } catch {
      studio().notify(PLAY_WORDS.people.pictureFailed, ToastTone.Error);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const field = (
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={(event) => void picked(event.target.files?.[0])}
    />
  );
  return { field, pick: () => input.current?.click(), busy };
}

/** Upload a photo, or another one while the photo shows. */
function UploadButton({ upload, hasPhoto }: { upload: PhotoUpload; hasPhoto: boolean }): JSX.Element {
  return (
    <Button className="account-upload" busy={upload.busy} data-avatar-upload onClick={upload.pick}>
      <Icon name="camera" />
      {uploadWords(upload.busy, hasPhoto)}
    </Button>
  );
}

/** Another generated avatar for the account, at once; waits until genex.games keeps one. */
function RegenerateButton({ me }: { me: PlayMe }): JSX.Element {
  const { available, regenerate } = useRegenerateAvatar(me);
  return (
    <Button className="account-upload" disabled={!available} data-avatar-regenerate onClick={regenerate}>
      <Icon name="dice" />
      {WORDS.regenerate}
    </Button>
  );
}

/**
 * The avatar row: Generated or Photo. Under them, Regenerate while the generated avatar shows, and
 * Upload while there is no photo yet or the photo shows; an empty Photo opens the picker too, and the
 * photo it uploads is then the one shown.
 */
function AvatarRow({ me }: { me: PlayMe }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const upload = usePhotoUpload();
  const known = me.avatarStyle !== null;
  const generated = shownStyle(me) === AvatarStyle.Generated;
  const choose = async (style: AvatarStyle): Promise<void> => {
    if (style === AvatarStyle.Photo && !me.photoUrl) {
      upload.pick();
      return;
    }
    if (style === shownStyle(me)) return;
    setBusy(true);
    try {
      await studio().people.setAvatarStyle(style);
    } catch {
      studio().notify(WORDS.styleFailed, ToastTone.Error);
    } finally {
      setBusy(false);
    }
  };
  const uploadShown = known && (!generated || !me.photoUrl);
  return (
    <div className="account-row" data-account-avatar>
      <span className="account-row-label">{WORDS.avatar}</span>
      <div className="account-row-body">
        <div className="account-choices" role="radiogroup" aria-label={WORDS.avatarLabel}>
          <Choice style={AvatarStyle.Generated} me={me} disabled={busy} onChoose={(style) => void choose(style)} />
          <Choice
            style={AvatarStyle.Photo}
            me={me}
            disabled={busy || upload.busy || !known}
            onChoose={(style) => void choose(style)}
          />
        </div>
        <div className="account-actions">
          {generated && <RegenerateButton me={me} />}
          {uploadShown && <UploadButton upload={upload} hasPhoto={me.photoUrl !== null} />}
        </div>
        {upload.field}
        {known && <span className="account-note">{WORDS.everywhere}</span>}
      </div>
    </div>
  );
}

/** The name row: the field, Save when it changed. */
function NameRow({ me }: { me: PlayMe }): JSX.Element {
  const [draft, setDraft] = useState(me.name);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(me.name), [me.name]);
  const name = playName(draft);
  const changed = name !== null && name !== me.name;
  const save = async (): Promise<void> => {
    if (!name || !changed || saving) return;
    setSaving(true);
    try {
      await studio().people.rename(name);
    } catch {
      studio().notify(PLAY_WORDS.people.renameFailed, ToastTone.Error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="account-row"
      data-account-name
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor="account-name" className="account-row-label">
        {WORDS.name}
      </label>
      <div className="account-row-body">
        <span className="account-name-line">
          <input
            id="account-name"
            className="account-name-field"
            value={draft}
            maxLength={PLAY_NAME_LENGTH.max + 10}
            aria-describedby="account-name-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && changed) {
                event.preventDefault();
                event.stopPropagation();
                setDraft(me.name);
              }
            }}
          />
          {changed && (
            <Button type="submit" variant="default" busy={saving}>
              {saving ? PLAY_WORDS.people.saving : PLAY_WORDS.people.save}
            </Button>
          )}
        </span>
        <span id="account-name-hint" className="account-note">
          {name === null ? PLAY_WORDS.people.nameRule : PLAY_WORDS.people.nameHint}
        </span>
      </div>
    </form>
  );
}

/** The Genex account's settings; while signed out, the way to connect. */
export function AccountSection(): JSX.Element {
  const me = usePeople((s) => s.me);
  if (!me)
    return (
      <div className="account-signed-out">
        <p className="text-ink-3">{WORDS.signedOut}</p>
        <Button onClick={() => openGenexPage(GenexTab.Tools)}>{WORDS.connect}</Button>
      </div>
    );
  return (
    <div className="account-section" data-account-section>
      <AvatarRow me={me} />
      <NameRow me={me} />
    </div>
  );
}
