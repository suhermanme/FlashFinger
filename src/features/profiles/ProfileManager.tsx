import { useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import type { ProfileSettings } from '../../contracts/models.js';
import type { Profile } from '../../contracts/models.js';
import type { ProfileCoordinator } from '../../app/profileCoordinator.js';
import type { ProfilesStore } from '../../state/profiles.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';

export interface ProfileManagerProps {
  coordinator: ProfileCoordinator;
  profilesStore: ProfilesStore;
  defaultSettings: ProfileSettings;
}

export function ProfileManager({ coordinator, profilesStore, defaultSettings }: ProfileManagerProps) {
  const profiles = useStore(profilesStore, (state) => state.profiles);
  const activeProfileId = useStore(profilesStore, (state) => state.activeProfileId);
  const hydration = useStore(profilesStore, (state) => state.hydration);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<Profile | null>(null);
  const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState<Profile | null>(null);

  const create = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void coordinator.createProfile({
      name: trimmed,
      avatarToken: 'default',
      analyticsZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      settings: defaultSettings,
    }).then((result) => { if (result.ok) setName(''); });
  };

  const saveEdit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = editName.trim();
    if (!editing || !trimmed) return;
    void coordinator.updateProfile({ ...editing, name: trimmed }).then((result) => {
      if (result.ok) setEditing(null);
    });
  };

  return (
    <section aria-labelledby="profiles-heading">
      <h1 id="profiles-heading">Profiles</h1>
      <ul aria-busy={hydration === 'loading'}>
        {profiles.map((profile) => (
          <li key={profile.id}>
            <button
              type="button"
              aria-current={profile.id === activeProfileId ? 'true' : undefined}
              onClick={() => void coordinator.switchProfile(profile.id)}
            >
              {profile.name}
            </button>
            <button type="button" onClick={() => { setEditing(profile); setEditName(profile.name); }}>
              Rename {profile.name}
            </button>
            <button type="button" onClick={() => setDeleting(profile)}>
              Delete {profile.name}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={create}>
        <label htmlFor="new-profile-name">Profile name</label>
        <input id="new-profile-name" value={name} maxLength={40} onChange={(event) => setName(event.currentTarget.value)} />
        <button type="submit">Create profile</button>
      </form>
      <Dialog open={editing !== null} title="Rename profile" onClose={() => setEditing(null)}>
        <form onSubmit={saveEdit}>
          <label htmlFor="rename-profile">Profile name</label>
          <input id="rename-profile" value={editName} maxLength={40} onChange={(event) => setEditName(event.currentTarget.value)} />
          <Button type="submit" variant="primary">Save name</Button>
        </form>
      </Dialog>
      <Dialog
        open={deleting !== null}
        title="Delete profile"
        onClose={() => setDeleting(null)}
        actions={<Button variant="primary" onClick={() => {
          if (!deleting) return;
          void coordinator.deleteProfile(deleting.id).then((result) => { if (result.ok) setDeleting(null); });
        }}>Delete profile</Button>}
      >
        <p>Delete {deleting?.name ?? 'this profile'} and all of its local history? This cannot be undone.</p>
      </Dialog>
    </section>
  );
}
