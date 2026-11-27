/**
 * Enter that commits text being composed (pinyin on an iPad): it belongs to the input method, never
 * to the form. Safari reports isComposing false on that key press, with keyCode 229.
 */
export const composingEnter = (event: {
  readonly keyCode: number;
  readonly nativeEvent: { readonly isComposing?: boolean };
}): boolean => event.nativeEvent.isComposing === true || event.keyCode === 229;
