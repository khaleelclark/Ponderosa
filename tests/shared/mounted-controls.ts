/** Open a Material UI select through the same pointer event as a user. */
export function openSelect(element:Element|null):void {
 if(!element)throw Error('Select control missing');
 element.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
}
