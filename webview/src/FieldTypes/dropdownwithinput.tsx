import * as React from 'react';
import { FieldBase } from './base';

interface Props {
    values: string[];
    optional?: boolean;
    /** If true, any value that isn't one of the dropdown-values gets shown as a string of asterisks */
    masked?: boolean;
    displayStyle?(item?: string): React.CSSProperties;
}
interface State {
    open: boolean;
    editing: boolean;
    draft: string;
}
export class FieldDropdownWithInput extends FieldBase<string | undefined, Props, State> {
    public mainDivRef = React.createRef<HTMLDivElement>();
    private cancelEdit = false;
    public componentDidMount() {
        window.addEventListener('click', this.onGlobalClick);
    }
    public componentWillUnmount() {
        window.removeEventListener('click', this.onGlobalClick);
    }
    public getInitialSubState(props: Props): State {
        return { open: false, editing: false, draft: '' };
    }
    public renderInput() {
        const { open } = this.state;
        return <div className="FieldDropdown FieldDropdownWithInput" ref={this.mainDivRef}>
            <p className="arrow" onClick={this.toggle}>▼</p>
            {this.renderCurrentValue()}
            {open && this.generateDropdown()}
        </div>;
    }
    protected renderCurrentValue() {
        const { masked, values } = this.props;
        const { newValue, editing, draft } = this.state;
        if (!masked) return <input className="current" value={newValue || ''} onChange={this.onChangeEvent} onClick={this.toggle} />;
        // Dropdown-values (e.g. '<Prompt>') aren't secret, show those as-is
        if (newValue !== undefined && values.includes(newValue))
            return <input className="current" value={newValue} readOnly onClick={this.toggle} />;
        if (editing) return <input className="current" autoFocus value={draft}
            placeholder="Type a new value, leave empty to keep the current one"
            onChange={this.onDraftChange} onBlur={this.onEditDone} onKeyDown={this.onEditKeyDown} />;
        return <input className="current" value={newValue ? '*'.repeat(newValue.length) : ''}
            placeholder={newValue ? undefined : 'Not set'}
            onFocus={this.startEdit} />;
    }
    protected startEdit = () => this.setState({ editing: true, draft: '' });
    protected onDraftChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ draft: event.target.value });
    };
    protected onEditKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        else if (event.key === 'Escape') {
            this.cancelEdit = true;
            event.currentTarget.blur();
        }
    };
    protected onEditDone = () => {
        const { draft } = this.state;
        const cancelled = this.cancelEdit;
        this.cancelEdit = false;
        this.setState({ editing: false, draft: '' });
        const newValue = draft.trim();
        if (!cancelled && newValue) this.onChange(newValue);
    };
    public onChangeEvent = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.onChange(event.target.value || undefined);
    }
    public generateDropdown() {
        const { displayStyle, values, optional } = this.props;
        const generateItem = (item: string | undefined, index: number) => {
            const style = displayStyle && displayStyle(item);
            return <li key={index} style={style} onClick={this.select.bind(this, item)}>
                {item}
            </li>
        };
        return <ul className="list">
            {optional && generateItem(undefined, -1)}
            {values.map(generateItem)}
        </ul>;
    }
    public select(newValue: string | undefined) {
        this.setState({ newValue, open: false, editing: false, draft: '' }, () => this.props.onChange(newValue));
    }
    public toggle = () => this.setState({ open: !this.state.open });
    public onGlobalClick = (event: MouseEvent) => {
        if (!this.state.open) return;
        if (event.composedPath().includes(this.mainDivRef.current!)) return;
        this.toggle();
    };
}
