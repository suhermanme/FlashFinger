export interface NavigationItem { id: string; label: string; href: string }
export interface NavigationProps { label?: string; activeId: string; items: readonly NavigationItem[] }
export function Navigation({ label = 'Main navigation', activeId, items }: NavigationProps) {
  return <nav aria-label={label}><ul className="ff-nav-list">{items.map((item) => <li key={item.id}>
    <a className="ff-nav-link" href={item.href} aria-current={item.id === activeId ? 'page' : undefined}>{item.label}</a>
  </li>)}</ul></nav>;
}
